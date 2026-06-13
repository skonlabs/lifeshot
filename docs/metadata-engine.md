# Universal Metadata Extraction & Indexing Engine

End-to-end pipeline for indexing photos, videos, documents, and audio from
local folders and cloud sources **without copying originals**.

## Architecture

```
Browser (File System Access API)        Edge Function `scans`            Postgres
────────────────────────────────        ─────────────────────            ────────
showDirectoryPicker → traverser  →  POST /v1/start              →  scan_sessions
      ↓                                                           
classifier → extractors (image,    POST /v1/:id/batch (idempotent) →  scan_batches
  video, audio, doc, hashes)              ingestBatch()                  +
      ↓                                       ↓                       assets
pending batch (≤ 50 records)         findOrCreateAsset()              asset_source_refs
      ↓                              writeSourceRef()                 asset_media_metadata
sync-client → POST batch             writeMetadataRows()              asset_exif / gps
                                     generateSearchDocument()         asset_video / document / audio
                                                                       asset_ai_enrichment
                                                                       assets.search_content
      ↓
POST /v1/:id/finalize  →  scan_sessions.status = 'completed'
```

## Privacy guarantees

- Original file bytes never leave the user's browser. Only metadata is sent.
- Local absolute paths are SHA-256 hashed (`normalized_absolute_path_hash`)
  for incremental dedup; only the **last two segments** are stored in
  `absolute_path_redacted` for display.
- Source provider tokens are never returned to the client.
- AI/face enrichment is gated on `ai_processing_consent` and
  `face_processing_consent` columns per scan session.

## API

| Method | Path                                | Purpose                          |
|--------|-------------------------------------|----------------------------------|
| POST   | `/scans/v1/start`                   | Start a scan session             |
| GET    | `/scans/v1/:id`                     | Full session row                 |
| GET    | `/scans/v1/:id/progress`            | Live counters + phase            |
| POST   | `/scans/v1/:id/batch`               | Ingest one batch of metadata     |
| POST   | `/scans/v1/:id/cancel`              | Request cancellation             |
| POST   | `/scans/v1/:id/resume`              | Resume a paused/cancelled scan   |
| POST   | `/scans/v1/:id/finalize`            | Mark scan complete               |
| POST   | `/scans/v1/:id/checkpoint`          | Persist a resume checkpoint      |
| GET    | `/scans/v1/:id/errors`              | List errors for a scan           |
| GET    | `/scans/v1/:id/results`             | List asset_ids upserted          |
| GET    | `/scans/v1/assets/:assetId/metadata`| Full canonical metadata view     |

Idempotency: each batch carries an `idempotencyKey`. Re-sending the same key
returns the previous summary without re-writing.

## Resumability

- `scan_checkpoints` stores the in-flight `directory_queue` plus the last
  processed path/source-asset id.
- `POST /v1/:id/resume` rehydrates the latest checkpoint, returning it to
  the client which restarts traversal from there.
- `scan_batches` deduplicates retried batches on `(scan_id, idempotency_key)`.

## Browser scan runner

`src/lib/metadata-engine/` exposes `runLocalScan({ rootHandle, … })`:

1. BFS traversal via `FileSystemDirectoryHandle.values()` (ignoring `.git`,
   `node_modules`, `Library`, `$RECYCLE.BIN`, …).
2. Classifier returns `{ mediaType, ignored }`.
3. Type-specific extractors run inside the browser:
   - photos → `createImageBitmap` for dimensions, lightweight EXIF sniff
   - videos → hidden `<video>` for duration + dimensions
   - audio  → hidden `<audio>` for duration
   - hashes → streaming SHA-256 via `crypto.subtle.digest`
4. Records accumulate in a `MetadataBatch` (≤50 records). When full it
   POSTs to `/v1/:id/batch`.
5. Per-file failures are captured into the batch `errors[]` array — the
   scan continues.

## Cloud sources

Existing connectors under `supabase/functions/_sources/*`
(`dropbox`, `onedrive`, `google_photos`, `local_ios`, `export_import`) feed
the same persistence layer through background jobs. Stub provider kinds
(`icloud_photos`, `amazon_photos`, `whatsapp_export`, `facebook_export`,
`instagram_export`) are accepted by `SourceKindSchema` and ready to wire
in once the spec-required connectors ship.

## Database

Migration `supabase/migrations/20260531150000_metadata_engine.sql` introduces:

- `scan_sessions`, `scan_checkpoints`, `scan_batches`, `scan_errors`
- `asset_media_metadata`, `asset_gps`, `asset_video_metadata`,
  `asset_document_metadata`, `asset_audio_metadata`
- Augments `asset_exif`, `asset_source_refs`, `source_accounts` with the
  spec's missing columns.

All user-owned tables have `auth.uid()`-based RLS plus explicit grants to
`authenticated` and `service_role`.

## Tests

- `supabase/functions/_tests/metadata.test.ts` — unit tests for the
  search-document generator and path-redaction helper.

Run with `deno test --allow-all supabase/functions/_tests/metadata.test.ts`.