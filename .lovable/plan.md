## Problem

Face thumbnails are blurry because the "original" image fed to the crop step is actually the provider's ~2048px preview (e.g. Google Photos `=w2048-h2048`, stored in `assets.proxy_cache_key`). Faces that occupy a small region of that preview get upscaled to 512×512 → soft crops.

## Fix

Keep Rekognition detection on the existing preview (5 MB API limit makes this the right tradeoff), but generate the **face crop from the true full-resolution original** fetched on-demand via the source connector (`getOriginalAccessToken`, e.g. Google Photos `=d`). Fall back to today's behavior when no connector original is available (local_ios, export_import, expired token, fetch failure).

## Changes

1. **`supabase/functions/_ai/face-pipeline.ts`**
   - Add an optional `cropSourceUrl: string | null` to `analyzeAssetFaces` opts.
   - When provided and fetchable, decode it once and use those bytes as `imageBytes` on the returned `FaceAnalysis` (currently `rekognitionSource.bytes`). This is the buffer `parseDetectedFaces` → `cropFace` reads from.
   - If the crop-source fetch fails or returns an unsupported MIME, silently fall back to `rekognitionSource.bytes` (today's behavior). No retryable errors — crop quality is best-effort.
   - Log once per asset when a higher-res source is used vs. fallback, for observability.

2. **`supabase/functions/_jobs/enrichAI.ts`**
   - Before calling `analyzeAssetFaces`, look up the primary `asset_refs` row for the asset, resolve the connector via `getConnector(...)` (same pattern as `normalizeMetadata.ts:296-311` and `hashAsset.ts:44-66`), and call `conn.getOriginalAccessToken(source_asset_id)`.
   - Pass the resulting URL as `cropSourceUrl` to `analyzeAssetFaces`. Wrap in try/catch — connector failure must not break face detection.
   - Skip the lookup for assets whose connector is known to have no separate original (`local_ios`, `export_import` — original already lives in the uploads bucket and `proxy_cache_key` already points there).

3. **No DB schema changes.** No migration. No changes to `cropFace`, `cover` selection, or the `people` UI — the same 512×512 data-URL is produced, just from sharper source pixels.

## Out of scope

- Re-crop existing low-res faces. Existing rows keep their current crops; only assets enriched after deploy benefit. If you want a backfill, that's a separate one-shot job (re-run `enrichAI` with `force_sync_run_id` for affected assets).
- Changing the 2048px preview sent to Rekognition (detection accuracy is fine; 5 MB API limit makes a larger image counterproductive).
- HEIC/HEIF originals (Rekognition still can't decode them; crop will still fall back to preview for those).

## Technical notes

- `getOriginalAccessToken` returns short-lived URLs (~50 min for Google). enrichAI fetches the bytes immediately, so expiry is not a concern within one job execution.
- Memory: a single full-res JPEG (typically 3–15 MB) is held in `FaceAnalysis.imageBytes` for the duration of `parseDetectedFaces`. Already the shape today — just larger bytes.
- The crop canvas already handles arbitrary input dimensions (`createImageBitmap` + `drawImage` with explicit `sx/sy/sw/sh` → 512×512). No code change needed in `cropFace`.
