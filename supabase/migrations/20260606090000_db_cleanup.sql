-- Drop dependent policy first; recreate without removed columns
drop policy if exists assets_owner_select on public.assets;

-- Tables (zero rows, no UI usage)
drop table if exists public.asset_album_memberships cascade;
drop table if exists public.asset_albums            cascade;
drop table if exists public.collection_assets       cascade;
drop table if exists public.smart_collections       cascade;
drop table if exists public.asset_devices           cascade;
drop table if exists public.asset_blurhashes        cascade;
drop table if exists public.asset_quality_scores    cascade;
drop table if exists public.asset_visibility        cascade;
drop table if exists public.asset_cache_status      cascade;
drop table if exists public.asset_search_index      cascade;
drop table if exists public.asset_dedup_groups      cascade;
drop table if exists public.asset_metadata          cascade;
drop table if exists public.asset_captions          cascade;
drop table if exists public.asset_labels            cascade;
drop table if exists public.asset_sensitive_flags   cascade;
drop table if exists public.asset_embeddings        cascade;
drop table if exists public.ai_vision_cache         cascade;
drop table if exists public.ai_embedding_cache      cascade;
drop table if exists public.memory_edges            cascade;
drop table if exists public.memory_nodes            cascade;
drop table if exists public.graph_snapshots         cascade;
drop table if exists public.face_clusters           cascade;
drop table if exists public.scan_roots              cascade;
drop table if exists public.ingestion_events        cascade;
drop table if exists public.user_activity_events    cascade;
drop table if exists public.performance_metrics     cascade;
drop table if exists public.system_config           cascade;
drop table if exists public.places_summary          cascade;

-- Slim assets table
alter table public.assets
  drop column if exists embedding_id,
  drop column if exists primary_source_ref_id,
  drop column if exists memory_node_id,
  drop column if exists place_id_text,
  drop column if exists dedup_group_id,
  drop column if exists capture_time_confidence,
  drop column if exists permission_state,
  drop column if exists visibility_state;

-- Recreate select policy (family sharing via family_id only; visibility_state removed)
create policy assets_owner_select on public.assets
  for select to authenticated
  using (
    deleted_state = 'active'::deleted_state
    and (
      user_id = auth.uid()
      or (family_id is not null and is_family_member(family_id))
    )
  );

-- Performance indexes
create index if not exists assets_user_capture_idx
  on public.assets (user_id, capture_time desc)
  where deleted_state = 'active';
create index if not exists assets_user_deleted_idx
  on public.assets (user_id, deleted_state);
create index if not exists asset_source_refs_account_idx
  on public.asset_source_refs (source_account_id);
create index if not exists person_faces_person_idx
  on public.person_faces (person_id);

comment on table public.assets is 'Canonical media records. 1 row per logical asset; n source rows in asset_source_refs.';
