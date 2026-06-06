-- Database cleanup: drop unused tables and columns.
-- All dropped tables were verified to have 0 rows and either no code refs
-- or only refs in code paths being patched out in the same commit.

-- Albums / collections (never built in UI)
drop table if exists public.asset_album_memberships cascade;
drop table if exists public.asset_albums            cascade;
drop table if exists public.collection_assets       cascade;
drop table if exists public.smart_collections       cascade;

-- Per-asset side tables we never wrote to or read from
drop table if exists public.asset_devices          cascade;
drop table if exists public.asset_blurhashes       cascade;
drop table if exists public.asset_quality_scores   cascade;
drop table if exists public.asset_visibility       cascade;
drop table if exists public.asset_cache_status     cascade;
drop table if exists public.asset_search_index     cascade;
drop table if exists public.asset_dedup_groups     cascade;
drop table if exists public.asset_metadata         cascade;

-- AI side tables no longer used
drop table if exists public.asset_captions         cascade;
drop table if exists public.asset_labels           cascade;
drop table if exists public.asset_sensitive_flags  cascade;
drop table if exists public.asset_embeddings       cascade;
drop table if exists public.ai_vision_cache        cascade;
drop table if exists public.ai_embedding_cache     cascade;

-- Graph/memory experiment (never surfaced)
drop table if exists public.memory_edges           cascade;
drop table if exists public.memory_nodes           cascade;
drop table if exists public.graph_snapshots        cascade;

-- Legacy face clustering (replaced by people + person_faces)
drop table if exists public.face_clusters          cascade;

-- Dead scan/ingest helpers
drop table if exists public.scan_roots             cascade;
drop table if exists public.ingestion_events       cascade;

-- Dead misc
drop table if exists public.user_activity_events   cascade;
drop table if exists public.performance_metrics    cascade;
drop table if exists public.system_config          cascade;
drop table if exists public.places_summary         cascade;

-- Slim assets table: drop columns that are never read or written
alter table public.assets
  drop column if exists embedding_id,
  drop column if exists primary_source_ref_id,
  drop column if exists memory_node_id,
  drop column if exists place_id_text,
  drop column if exists dedup_group_id,
  drop column if exists capture_time_confidence,
  drop column if exists permission_state,
  drop column if exists visibility_state;

-- Helpful indexes for the queries the app actually runs
create index if not exists assets_user_capture_idx
  on public.assets (user_id, capture_time desc)
  where deleted_state = 'active';
create index if not exists assets_user_deleted_idx
  on public.assets (user_id, deleted_state);
create index if not exists asset_source_refs_account_idx
  on public.asset_source_refs (source_account_id);
create index if not exists person_faces_person_idx
  on public.person_faces (person_id);

comment on table public.assets is
  'Canonical media records. 1 row per logical asset; n source rows in asset_source_refs.';
comment on table public.asset_thumbnails is '1:1 square thumbnail + dominant color.';
comment on table public.asset_derivatives is 'n derivatives per asset (web/preview/poster).';
comment on table public.asset_hashes is '1:1 sha256 + perceptual hash.';
comment on table public.asset_exif is '1:1 raw EXIF.';
comment on table public.asset_organization_signals is '1:1 place/event/activity signals.';
comment on table public.asset_search_documents is '1:1 FTS tsvector + narrative.';
comment on table public.person_faces is 'Detected faces, n per asset, clustered into people.';
comment on table public.people is 'Clustered person identities.';
