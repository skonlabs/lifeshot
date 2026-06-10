# Sync + face-recognition hardening

After a full trace of the pipeline (`syncSource → normalizeMetadata → enrichAI → clusterPeople`, plus the worker drain loop), most of your 8 items are already implemented correctly. The real bugs are concentrated in face handling. This plan fixes only what's actually broken, so nothing else regresses.

## What is already correct (won't touch)

- **Sync / force-sync flow.** `force` clears cursors, bypasses staleness, and uses a unique run-id idempotency key. Normal sync resumes from `source_sync_cursors`.
- **Auto-stop when done.** `source_sync_jobs.status` flips to `completed` only when there are no more pages *and* zero pending `normalizeMetadata` jobs. Worker self-perpetuates only while `job_queue` has pending rows, then naturally stops.
- **Data extraction coverage.** Every job writes to the right tables (`assets`, `asset_media_metadata`, `asset_exif`, `asset_gps`, `asset_xmp_iptc`, `asset_ai_enrichment`, `people`, `places`, `events`, `event_assets`, etc.). No table is being skipped.
- **Loop safety.** `syncSource` already detects identical-cursor loops and force-terminates.

## Real bugs to fix

### Bug 1 — Non-front-facing faces enter the AWS Rekognition collection
`face-detector.ts` calls `indexFaces` with **all** detected faces. The pose/quality filter (Yaw ≤ 30°, Pitch ≤ 25°, Sharpness ≥ 35, Brightness ≥ 25, Confidence ≥ 0.6) runs **after** indexing in `enrichAI.ts`. Rejected faces stay in the AWS collection and pollute future `SearchFaces` calls.

**Fix:** Move the pose/quality filter into `face-detector.ts`, applied to Rekognition's returned `FaceDetail` *before* deciding what to keep. Any face that fails the filter gets `deleteFaces` called immediately on its FaceId so the collection stays clean. The filter constants get extracted into one shared module (`_ai/face-quality.ts`) so detector + enrich + cluster all use the same thresholds.

### Bug 2 — `clusterPeople` re-trusts `enrichAI` faces without re-filtering
If older `asset_ai_enrichment` rows were written before Bug 1 was fixed (or by an older code path), they may still contain non-front-facing entries. `clusterPeople` blindly iterates them.

**Fix:** Apply the same shared `isUsableFace()` check in `clusterPeople` before clustering. Faces that fail are silently skipped (not deleted from `asset_ai_enrichment` — that's the cleanup migration's job).

### Bug 3 — Cross-run duplicate in `people.faces`
The existing idempotency check only rejects exact `(asset_id, face_id)` repeats. A bad assignment in one run can leave a `(asset_id, face_id)` row pointing to person A; a later run that correctly maps the same `face_id` to person B will append a *second* entry on B without removing the wrong one on A.

**Fix:** Before appending in `clusterPeople`, scan *all* people for any existing `(asset_id, face_id)` entry. If found on a different person, remove it from that person and re-attach to the correct one (and recompute that person's `face_count` and `cover`). Net effect: every `(asset_id, face_id)` lives on exactly one person.

### Bug 4 — Missing `UNIQUE(user_id, auto_label)` on `people`
`clusterPeople` upserts with `onConflict: "user_id,auto_label"`, but no migration adds that unique index. PostgREST upserts without a real unique constraint silently insert duplicate rows.

**Fix:** Add migration `add_people_user_auto_label_unique.sql` that creates the unique index. Before creating it, the same migration de-duplicates any existing rows by merging their `faces`, `rekognition_face_ids`, `face_count`, and keeping the earliest `id`.

### Bug 5 — Existing duplicate / non-front-facing faces in `people.faces`
Backfill the cleanup so the people grid stops showing fake "extra" people.

**Fix:** One-time migration `cleanup_people_faces.sql` that:
1. For each row in `people`, rewrites `faces` to keep only entries where the embedded `rekognition_response` attributes pass the quality filter (Yaw/Pitch/Sharpness/Brightness/Confidence). Entries missing attributes are kept (we can't judge them).
2. Deduplicates the resulting array on `(asset_id, rekognition_face_id)` — keeps the highest-confidence copy.
3. Recomputes `face_count` and `cover_asset_id`/`cover_bbox` from the new array.
4. Deletes any `people` row that ends up with `face_count = 0`.
5. Removes orphan FaceIds from `rekognition_face_ids` that no longer appear in `faces`.

The migration is idempotent (safe to re-run) and runs in a single transaction.

## What I will not change (and why)

- **No queue/worker rewrite.** The worker already auto-terminates and the 504s you saw earlier were on read endpoints (`/accounts`, `/people`), not on sync itself. Those are already mitigated by the 4 s provider timeout and graceful-degradation fallbacks added in earlier turns.
- **No deletion of dead-code jobs** (`materializeTimelineWindows`, `disconnectSource`, `deleteAccount`, `exportUserData`). They're registered but not enqueued from anywhere — leaving them in `registry.ts` is harmless and removing them risks breaking a future wiring you may add. I'll just note them.
- **No change to `syncSource` / `normalizeMetadata` chaining.** It works.

## Why this won't break anything

- All filter thresholds match what `enrichAI.ts` already uses — same numbers, just applied earlier and in more places. Existing behavior for compliant faces is unchanged.
- The cleanup migration only *removes* entries; no new rows, no schema-shape change. The `people` table columns stay identical.
- The unique-index migration first merges any pre-existing duplicates, so the `CREATE UNIQUE INDEX` cannot fail.
- `clusterPeople`'s cross-person move is gated behind the same `(asset_id, face_id)` key it already uses, so on a clean DB it's a no-op.
- No edge-function entry points, no route files, no UI files touched.

## Files changed

```text
NEW   supabase/functions/_ai/face-quality.ts              shared isUsableFace() + thresholds
EDIT  supabase/functions/_ai/face-detector.ts             pre-index filter + deleteFaces for rejects
EDIT  supabase/functions/_jobs/enrichAI.ts                use shared filter (delete inline copy)
EDIT  supabase/functions/_jobs/clusterPeople.ts           re-filter + cross-person dedup move
NEW   supabase/migrations/<ts>_people_user_auto_label_unique.sql
NEW   supabase/migrations/<ts>_cleanup_people_faces.sql
```

## Verification after build

1. `psql` check that the unique index exists and `people` has no `(user_id, auto_label)` dups.
2. `psql` check that no row in `people.faces` has Yaw/Pitch outside thresholds (where attributes present).
3. Open `/people` in the preview and confirm faces render without the "same person split across tiles" symptom.
4. Trigger a force-sync on one account and watch `source_sync_jobs.status` flip `running → completed` with `pending_normalize_jobs = 0`.

If you approve, I'll execute in this exact order and stop only if a step fails.