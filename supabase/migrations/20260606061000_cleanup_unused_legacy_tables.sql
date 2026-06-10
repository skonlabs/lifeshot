-- Cleanup legacy tables no longer needed by shipped product features.
-- Kept intentionally narrow so search, duplicates, people, places, events,
-- EXIF/GPS, OCR, and thumbnails continue to work.

drop table if exists public.asset_metadata cascade;
drop table if exists public.asset_devices cascade;
drop table if exists public.asset_quality_scores cascade;
drop table if exists public.asset_visibility cascade;
drop table if exists public.asset_blurhashes cascade;
drop table if exists public.asset_cache_status cascade;
drop table if exists public.face_clusters cascade;
drop table if exists public.smart_collections cascade;
drop table if exists public.collection_assets cascade;

alter table public.assets
  drop column if exists primary_source_ref_id,
  drop column if exists embedding_id,
  drop column if exists memory_node_id,
  drop column if exists permission_state;
