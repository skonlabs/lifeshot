-- 20260601050000_asset_source_refs_columns.sql
-- Adds missing columns to asset_source_refs that syncSource and normalizeMetadata
-- reference but that were never present in the original schema.
--
-- source_kind:          which provider type (dropbox, google_photos, etc.)
--                       required for the sources filter in hybrid_search
-- source_relative_path: path within the provider filesystem (e.g. /Photos/IMG_001.jpg)
--                       used by normalizeMetadata to build asset_file_metadata
-- source_modified_at:   provider-reported last-modified time
--                       used by syncSource to detect changed files and re-enqueue
--                       normalizeMetadata only when content has actually changed

alter table public.asset_source_refs
  add column if not exists source_kind text,
  add column if not exists source_relative_path text,
  add column if not exists source_modified_at timestamptz;

-- Index for the sources filter in hybrid_search (asr.source_kind = any(...))
create index if not exists idx_asset_source_refs_kind
  on public.asset_source_refs(source_kind)
  where source_kind is not null;
