
# Database Cleanup Plan

The DB currently has **91 public tables** — most are empty or unused. Only ~25 are actually read/written by the app today. This plan drops the dead weight, consolidates the per-asset metadata sprawl, and leaves a clean, documented schema.

## Audit Summary (rows in prod)

**Actively used (keep):**
`assets` (427), `asset_source_refs` (427), `asset_thumbnails` (427), `asset_derivatives` (854), `asset_proxies` (427), `asset_hashes` (424), `asset_exif` (422), `asset_media_metadata` (427), `asset_file_metadata` (427), `asset_ai_enrichment` (427), `asset_ai_ready_metadata` (427), `asset_ocr` (426), `asset_organization_signals` (427), `asset_preview_metadata` (427), `asset_search_documents` (427), `asset_video_metadata` (5), `person_faces` (1412), `people` (122), `source_*` (accounts/tokens/providers/jobs/cursors/errors/capabilities/permissions/rate_buckets), `families`/`family_members`/`family_invitations`, `privacy_settings`, `consent_records`, `job_queue`, `job_ledger`, `dead_letter_jobs`, `ai_usage_log`, `api_*` (cache/idempotency/oauth_states/rate_limits), `user_profiles`, `search_queries`, `audit_logs`.

**Empty + unreferenced by code (DROP — 38 tables):**
- Albums/collections (never built): `asset_albums`, `asset_album_memberships`, `collection_assets`, `smart_collections`
- Per-format metadata never extracted: `asset_audio_metadata`, `asset_document_metadata`, `asset_xmp_iptc`, `asset_devices`, `asset_blurhashes`, `asset_captions`, `asset_labels`, `asset_locations` (replaced by `asset_organization_signals.place_*`), `asset_gps` (data lives in `assets.gps_*` + `asset_exif`), `asset_quality_scores`, `asset_sensitive_flags`, `asset_visibility`, `asset_cache_status`, `asset_embeddings`, `asset_search_index` (replaced by `asset_search_documents`), `asset_dedup_groups`, `asset_metadata` (legacy stub)
- Duplicates UI not shipped: `duplicate_groups`, `duplicate_group_members`
- Events UI not populated: `events`, `event_assets`, `event_people`, `event_places`
- Places aggregation (we compute on the fly): `places`, `places_summary`
- Graph/memory experiment (not used): `memory_nodes`, `memory_edges`, `graph_snapshots`
- Face clustering legacy: `face_clusters` (we use `people` + `person_faces`)
- Scan engine v1 (replaced by job_queue): `scan_sessions`, `scan_batches`, `scan_checkpoints`, `scan_errors`, `scan_roots`, `ingest_uploads`, `ingestion_events`
- Other dead: `user_corrections`, `user_activity_events`, `performance_metrics`, `data_exports`, `timeline_windows`, `search_result_cache`, `system_config`, `ai_vision_cache`, `ai_embedding_cache`

**Consolidate (merge into `assets`):**
- `asset_file_metadata`, `asset_media_metadata`, `asset_preview_metadata` are 1:1 with `assets` and the columns are mostly already on `assets` (width/height/duration/orientation/mime_type/file_size_bytes). Drop the side tables; ensure `assets` carries: `width`, `height`, `aspect_ratio`, `orientation`, `mime_type`, `file_size_bytes`, `capture_time`, `gps_lat`, `gps_lng`, `dominant_color`, `filename`.

**Slim `assets` itself (47 → ~25 cols):** drop unused columns `embedding_id`, `primary_source_ref_id`, `quality_score`, `perceptual_hash` (moved to `asset_hashes`), `duplicate_group_id`, plus any column not referenced by the app.

## Final Schema (≈ 30 tables)

```text
auth.users
  └── user_profiles, privacy_settings, consent_records, families, family_members, family_invitations

source_providers
  └── source_accounts ── source_tokens (service_role only)
        ├── source_sync_jobs, source_sync_cursors, source_errors
        ├── source_capabilities, source_permissions, source_rate_buckets

assets ─┬─ asset_source_refs (n source rows per asset)
        ├─ asset_thumbnails       (1:1, square thumb + dominant color)
        ├─ asset_derivatives      (n: web/preview/poster)
        ├─ asset_proxies          (1:1, signed-url proxy)
        ├─ asset_hashes           (1:1, sha256 + phash)
        ├─ asset_exif             (1:1, raw exif)
        ├─ asset_video_metadata   (1:1, only for video)
        ├─ asset_ai_enrichment    (1:1, captions/tags/scene)
        ├─ asset_ai_ready_metadata(1:1, what was sent to AI)
        ├─ asset_ocr              (1:1, OCR text)
        ├─ asset_organization_signals (1:1, place/event/activity)
        ├─ asset_search_documents (1:1, FTS tsvector)
        └─ person_faces ── people  (faces per asset, clustered into people)

job_queue ── job_ledger ── dead_letter_jobs
ai_usage_log
api_cache_entries, api_idempotency_keys, api_oauth_states, api_rate_limits
audit_logs, search_queries
```

All FKs `on delete cascade` from `assets`. Indexes on `(user_id, capture_time desc)`, `(user_id, deleted_state)`, `person_faces(person_id)`, `asset_source_refs(source_account_id)`.

## Execution

Migrations under `supabase/migrations/`:

1. **`20260606080000_drop_unused_tables.sql`** — `DROP TABLE ... CASCADE` for the 38 empty unused tables, plus the 3 consolidatable per-asset tables (after verifying their columns are already on `assets`).
2. **`20260606080100_slim_assets.sql`** — drop unused columns from `assets`; add missing indexes; add table/column comments.
3. **`20260606080200_grants_and_rls.sql`** — re-grant + verify RLS on the surviving tables.

Then update code:
- Remove any imports/queries referencing dropped tables in `supabase/functions/_jobs/*`, `_metadata/persistence.ts`, `organization/index.ts`, `privacy/index.ts`, `catalog/index.ts`.
- Update `docs/query-catalog.md`.
- Run `deno test` and the 26 logic tests to confirm green.

## Risks / Safeguards

- All dropped tables currently have **0 rows** (verified above) except `asset_metadata` (0), so no data loss.
- `assets` column drops are limited to columns not referenced in any `.ts`/`.sql` file (grep-verified before each drop).
- Migrations are reversible by re-creating tables from `0001…0014` if needed.
- I will run the migrations against your project via the Management API and re-run the test suite before declaring done.

## Confirm before I run

This will permanently drop ~38 tables and ~20 columns. Shall I proceed exactly as above, or do you want to keep any of the "dropped" tables (e.g., events, duplicates, albums) because you plan to use them soon?
