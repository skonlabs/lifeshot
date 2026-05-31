# Universal Metadata Extraction & Indexing Engine — Implementation Plan

You asked for 100% of the spec. Honest reality check: the full spec is ~100 files (schema, extractors, connectors, APIs, tests, docs). I cannot ship all of it in one turn without it being shallow and broken. I will ship it in **5 sequential batches**, each one self-contained, deployable, and tested. You approve this plan once; then I drive each batch without re-asking.

## Adaptations from spec → your stack

The spec assumes Next.js + Node.js. Your stack is **TanStack Start (Cloudflare Workers) + Supabase Edge Functions (Deno)**. Adaptations:

| Spec says | We use | Why |
|---|---|---|
| Next.js API routes | Existing Supabase Edge Functions (`sources`, `catalog`, …) + new `scans` function | Match existing pattern |
| readdirp / chokidar (Node FS) | **Browser File System Access API** | No host FS in Workers/Deno; user picks folder in browser, JS walks it, posts normalized records |
| sharp / ffprobe (native) | **In-browser**: `<img>`/`createImageBitmap` for dims, `HTMLVideoElement` for duration, `exifr` (works in browser) for EXIF/GPS/XMP | No native binaries in either runtime |
| pdf-parse / mammoth / xlsx | `pdfjs-dist`, `mammoth` browser build, `xlsx` (all browser-compatible) | Run in user's browser |
| Trigger.dev / Inngest | Existing `job_queue` + `worker` edge function | Already built |
| Redis progress cache | Supabase Realtime on `scan_sessions` row | Already wired |

Original files are **never uploaded** — only metadata. This is the privacy win.

## The 5 batches

### Batch 1 — Schema, RLS, types (this turn)
- Migration `0001_metadata_engine_schema.sql`: `scan_sessions`, `scan_roots`, `scan_checkpoints`, `scan_batches`, `scan_errors`, `asset_file_metadata`, `asset_media_metadata`, `asset_exif`, `asset_gps`, `asset_xmp_iptc`, `asset_video_metadata`, `asset_document_metadata`, `asset_audio_metadata`, `asset_hashes`, `asset_preview_metadata`, `asset_ai_ready_metadata`, `asset_organization_signals`, `asset_search_documents`. Reuses existing `assets`, `asset_source_refs`, `source_accounts`.
- Migration `0002_metadata_engine_indexes.sql`: GIN on `search_vector`, btree on `(user_id, capture_time)`, `(user_id, normalized_absolute_path_hash)`, `(source_account_id, source_asset_id)`, perceptual-hash indexes.
- Migration `0003_metadata_engine_rls.sql`: `user_id = auth.uid()` policies + `service_role` grants + `authenticated` SELECT grants on user-owned tables.
- `packages/core/metadata/types.ts` + Zod schemas: `ScanRequest`, `ScanProgress`, `ScanSession`, `ScanCheckpoint`, `ScanError`, `CanonicalMetadataRecord`, `FileSystemMetadata`, `MediaMetadata`, `ExifMetadata`, `GpsMetadata`, `XmpIptcMetadata`, `VideoMetadata`, `DocumentMetadata`, `AudioMetadata`, `HashMetadata`, `PreviewMetadata`, `AiReadyMetadata`, `OrganizationSignals`, `MetadataBatch`, `BatchSummary`, `ExtractionStatus`.

### Batch 2 — Edge function: `scans` API + persistence layer
- `supabase/functions/scans/index.ts` with routes: `POST /v1/scans/start`, `GET /v1/scans/:id`, `GET /v1/scans/:id/progress`, `POST /v1/scans/:id/cancel`, `POST /v1/scans/:id/resume`, `GET /v1/scans/:id/results`, `GET /v1/scans/:id/errors`, `POST /v1/scans/:id/batch` (ingest endpoint client calls with normalized metadata), `GET /v1/assets/:id/metadata`.
- `supabase/functions/_metadata/` shared module: `metadata-repository.ts`, `batch-writer.ts` (chunked upserts, 200/batch), `scan-session-repository.ts`, `checkpoint-repository.ts`, `scan-error-repository.ts`, `search-document-generator.ts` (server-side normalizer that produces the human-readable narrative), `canonical-asset-normalizer.ts`, `gps-normalizer.ts`, `timestamp-normalizer.ts`, `path-redaction.ts`, `error-normalizer.ts`.
- Idempotent upserts keyed on `(source_account_id, source_asset_id)`. Path redaction + hashing before any client-visible row. Source tokens never returned.

### Batch 3 — Browser scan runner (Local Folder via FS Access API)
- `src/lib/metadata-engine/` runs in browser:
  - `scan-orchestrator.ts` — picks folder via `showDirectoryPicker()`, drives traversal, concurrency (`p-limit`-style), batching, progress, cancel/resume via `AbortController` + IndexedDB checkpoint.
  - `traversal/recursive-folder-traverser.ts` — iterative BFS over `FileSystemDirectoryHandle`, depth/symlink/hidden rules, ignore list (`.git`, `node_modules`, `Library/Caches`, `$RECYCLE.BIN`, `.Trashes`, `Thumbs.db`).
  - `classification/file-classifier.ts` + `supported-extensions.ts` + `mime-detector.ts` (magic-byte sniff on first 4KB).
  - `extractors/`: `file-system-extractor.ts`, `image-metadata-extractor.ts` (createImageBitmap), `exif-extractor.ts` + `xmp-iptc-extractor.ts` (exifr, browser build), `gps-normalizer.ts`, `video-metadata-extractor.ts` (HTMLVideoElement metadata), `audio-metadata-extractor.ts` (music-metadata browser), `document-metadata-extractor.ts` (pdfjs-dist for PDF page count, lightweight DOCX/XLSX header read), `hash-extractor.ts` (streaming SHA-256 via SubtleCrypto), `perceptual-hash-extractor.ts` (8x8 dct/dHash on downscaled canvas), `preview-metadata-extractor.ts` (blurhash + dominant color from 32x32 canvas), `organization-signal-extractor.ts`, `search-document-generator.ts` (client-side preview; server re-generates canonical).
  - `persistence/sync-client.ts` — posts batches to `/v1/scans/:id/batch` with idempotency keys, retries, backoff.
  - `errors/scan-error.ts` + `error-codes.ts` — per-file error capture, never aborts whole scan.
- UI: new route `/_authenticated/scans` with "Scan a local folder" button, live progress bar (folders, supported, processed, skipped, errors, current path redacted), cancel/resume controls, error log table.
- Cloud-source scans (Dropbox/OneDrive/Google Photos) reuse the same `scans` API but the listing runs server-side in the existing `_sources/*` connectors → enqueues `normalizeMetadata` jobs that fill the new tables.

### Batch 4 — Cloud connector stubs + extractor wiring on server side
- Wire existing `_jobs/normalizeMetadata.ts` + `enrichAI.ts` + `ocrAsset.ts` + `hashAsset.ts` to populate the new `asset_exif/gps/xmp_iptc/video/document/audio/hashes/search_documents` tables (currently they only touch `assets` + `asset_search_index`).
- Stub connector files for `icloud_photos`, `amazon_photos`, `whatsapp_export`, `facebook_export`, `instagram_export` (with real `getCapabilities()`, typed `listAssets()` signature, `NotImplementedError` body). Two of these already exist as stubs — fill in capabilities matrix.
- Server-side `search-document-generator.ts` job replaces the current `indexSearchDocument` body with the spec's narrative format.

### Batch 5 — Tests + docs
- `supabase/functions/_tests/metadata.test.ts` — unit tests for normalizers, search-document generator, path redaction, error normalization, GPS/timestamp normalization, Zod schema round-trips.
- `supabase/functions/_tests/scans.test.ts` — integration: start → batch ingest → progress → cancel → resume → errors → results.
- `src/lib/metadata-engine/__tests__/` — vitest for classifier, traversal (mocked FS handles), hash, search-document.
- `docs/metadata-engine.md`, `local-folder-scanning.md`, `source-connectors.md`, `metadata-schema.md`, `api-reference.md`, `operations-runbook.md`.

## Non-negotiables enforced throughout
- No original file is ever uploaded or copied. Browser only reads & extracts; only metadata goes to the server.
- No file is modified/renamed/moved/deleted.
- Streaming hash via `crypto.subtle.digest` on chunked `ReadableStream` — never `await file.arrayBuffer()` for >50MB.
- One failed file → captured in `scan_errors`, scan continues.
- `auth.uid()` RLS on every user-owned table; service-role only for background writes.
- Local absolute paths are SHA-256 hashed (`normalized_absolute_path_hash`) for incremental dedup, and stored as `absolute_path_redacted` (last 2 segments only) for display.
- AI/face processing gated on `ai_processing_consent` / `face_processing_consent` columns on `scan_sessions`.

## What you get per batch
Each batch ends with a working, deployable increment. After Batch 1 the schema exists. After Batch 2 the API works (manual curl). After Batch 3 you can scan a real local folder end-to-end. Batches 4 & 5 round out cloud parity + tests + docs.

## What I need from you
Approve this plan and I start Batch 1 immediately. No further questions until Batch 3 (UI design choices for the scan progress page).
