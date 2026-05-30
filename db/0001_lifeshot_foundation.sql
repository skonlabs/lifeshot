-- ============================================================================
-- LifeShot — Phase 1/2/3 Foundation Schema
-- Run this in your Supabase SQL Editor (project: vohevknnbvpaooletyts).
-- Safe to run multiple times: uses IF NOT EXISTS / CREATE OR REPLACE.
-- ============================================================================

-- Extensions
create extension if not exists "pgcrypto";
create extension if not exists "vector";
create extension if not exists "postgis";

-- ============================================================================
-- ENUMS
-- ============================================================================
do $$ begin
  create type public.app_role as enum ('admin','user');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.family_role as enum ('owner','admin','member','child','elder','viewer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.provider_id as enum (
    'google_photos','dropbox','onedrive','ios_device','android_device',
    'desktop_folder','whatsapp_import','fb_export','ig_export'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.sync_status as enum ('queued','running','done','failed','partial');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.asset_visibility as enum ('private','family','shared');
exception when duplicate_object then null; end $$;

-- ============================================================================
-- ROLES (separate table per security best practice)
-- ============================================================================
create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role);
$$;

-- ============================================================================
-- IDENTITY & PROFILE
-- ============================================================================
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  locale text,
  timezone text,
  is_minor boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.privacy_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ai_processing boolean not null default true,
  face_clustering boolean not null default false,
  share_with_family boolean not null default false,
  per_source jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.consent_records (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,         -- 'ai','face','family_share','source_specific'
  granted boolean not null,
  context jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_consent_user on public.consent_records(user_id, created_at desc);

-- ============================================================================
-- FAMILIES
-- ============================================================================
create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.family_members (
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role family_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (family_id, user_id)
);
create index if not exists idx_family_members_user on public.family_members(user_id);

create table if not exists public.family_invitations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  email text not null,
  role family_role not null default 'member',
  token text not null unique,
  invited_by uuid references auth.users(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function public.is_family_member(_user uuid, _family uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.family_members where user_id = _user and family_id = _family);
$$;

-- ============================================================================
-- SOURCE MANAGEMENT
-- ============================================================================
create table if not exists public.source_providers (
  id provider_id primary key,
  display_name text not null,
  capabilities jsonb not null,           -- normalized SourceCapabilities
  is_active boolean not null default true
);

insert into public.source_providers (id, display_name, capabilities) values
  ('google_photos','Google Photos','{"hasDelta":false,"hasWebhook":false,"hasThumbnails":true,"hasOriginals":true,"thumbnailCachePolicy":"none","originalAccess":"short-lived","supportsAlbums":true,"supportsVideo":true}'::jsonb),
  ('dropbox','Dropbox','{"hasDelta":true,"hasWebhook":true,"hasThumbnails":true,"hasOriginals":true,"thumbnailCachePolicy":"long","originalAccess":"short-lived","supportsAlbums":false,"supportsVideo":true}'::jsonb),
  ('onedrive','OneDrive','{"hasDelta":true,"hasWebhook":true,"hasThumbnails":true,"hasOriginals":true,"thumbnailCachePolicy":"long","originalAccess":"signed-url","supportsAlbums":true,"supportsVideo":true}'::jsonb),
  ('ios_device','iPhone / iPad','{"hasDelta":true,"hasWebhook":false,"hasThumbnails":true,"hasOriginals":true,"thumbnailCachePolicy":"long","originalAccess":"device-only","supportsAlbums":true,"supportsVideo":true}'::jsonb),
  ('android_device','Android','{"hasDelta":true,"hasWebhook":false,"hasThumbnails":true,"hasOriginals":true,"thumbnailCachePolicy":"long","originalAccess":"device-only","supportsAlbums":true,"supportsVideo":true}'::jsonb),
  ('desktop_folder','Desktop folder','{"hasDelta":true,"hasWebhook":false,"hasThumbnails":true,"hasOriginals":true,"thumbnailCachePolicy":"long","originalAccess":"device-only","supportsAlbums":false,"supportsVideo":true}'::jsonb),
  ('whatsapp_import','WhatsApp import','{"hasDelta":false,"hasWebhook":false,"hasThumbnails":true,"hasOriginals":true,"thumbnailCachePolicy":"long","originalAccess":"direct","supportsAlbums":false,"supportsVideo":true}'::jsonb),
  ('fb_export','Facebook export','{"hasDelta":false,"hasWebhook":false,"hasThumbnails":true,"hasOriginals":true,"thumbnailCachePolicy":"long","originalAccess":"direct","supportsAlbums":true,"supportsVideo":true}'::jsonb),
  ('ig_export','Instagram export','{"hasDelta":false,"hasWebhook":false,"hasThumbnails":true,"hasOriginals":true,"thumbnailCachePolicy":"long","originalAccess":"direct","supportsAlbums":true,"supportsVideo":true}'::jsonb)
on conflict (id) do update set capabilities = excluded.capabilities, display_name = excluded.display_name;

create table if not exists public.source_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider provider_id not null references public.source_providers(id),
  external_account_id text,
  display_name text,
  status text not null default 'active',  -- active|paused|revoked|error
  capabilities jsonb,
  scopes text[],
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  unique (user_id, provider, external_account_id)
);
create index if not exists idx_source_accounts_user on public.source_accounts(user_id);

-- Encrypted tokens: service_role ONLY, never client-readable.
create table if not exists public.source_tokens (
  source_account_id uuid primary key references public.source_accounts(id) on delete cascade,
  ciphertext bytea not null,
  nonce bytea not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.source_sync_cursors (
  source_account_id uuid not null references public.source_accounts(id) on delete cascade,
  scope text not null,                -- 'assets','albums'
  cursor text,
  last_run_at timestamptz,
  primary key (source_account_id, scope)
);

create table if not exists public.source_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid not null references public.source_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  job_type text not null,             -- initial|delta|backfill|repair
  status sync_status not null default 'queued',
  workflow_run_id text,               -- Inngest run id
  stats jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_sync_jobs_account on public.source_sync_jobs(source_account_id, created_at desc);

create table if not exists public.source_errors (
  id bigserial primary key,
  source_account_id uuid references public.source_accounts(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  code text,
  message text,
  context jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_source_errors_account on public.source_errors(source_account_id, created_at desc);

-- ============================================================================
-- CANONICAL ASSET CATALOG
-- ============================================================================
create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  family_id uuid references public.families(id) on delete set null,
  media_type text not null,                     -- image|video|live|other
  mime_type text,
  capture_time timestamptz,
  capture_time_confidence real default 0.0,
  timezone text,
  upload_time timestamptz,
  created_time timestamptz,
  modified_time timestamptz,
  width int, height int,
  duration_ms int,
  file_size_bytes bigint,
  content_hash_sha256 bytea,                    -- exact dedupe
  perceptual_hash bigint,                       -- 64-bit pHash
  video_fingerprint bytea,
  location geography(point, 4326),
  location_lat double precision,
  location_lng double precision,
  location_city text,
  location_country text,
  location_confidence real,
  place_id uuid,
  event_id uuid,
  device_make text, device_model text,
  blurhash text, dominant_color text,
  quality_score real,
  duplicate_group_id uuid,
  merged_into_asset_id uuid references public.assets(id) on delete set null,
  visibility asset_visibility not null default 'private',
  permission_state text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_assets_user_time on public.assets(user_id, capture_time desc) where deleted_at is null;
create index if not exists idx_assets_user_dgroup on public.assets(user_id, duplicate_group_id) where deleted_at is null;
create index if not exists idx_assets_user_event on public.assets(user_id, event_id) where deleted_at is null;
create index if not exists idx_assets_user_place on public.assets(user_id, place_id) where deleted_at is null;
create index if not exists idx_assets_phash on public.assets(perceptual_hash) where deleted_at is null;
create index if not exists idx_assets_sha on public.assets(content_hash_sha256) where deleted_at is null;
create index if not exists idx_assets_location on public.assets using gist (location) where deleted_at is null;
create index if not exists idx_assets_family on public.assets(family_id) where visibility <> 'private';

create table if not exists public.asset_source_refs (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  source_account_id uuid not null references public.source_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_asset_id text not null,
  provider_metadata jsonb,
  is_primary boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (source_account_id, source_asset_id)
);
create index if not exists idx_asr_asset on public.asset_source_refs(asset_id);
create index if not exists idx_asr_user on public.asset_source_refs(user_id);

create table if not exists public.asset_exif (
  asset_id uuid primary key references public.assets(id) on delete cascade,
  data jsonb not null
);

create table if not exists public.asset_albums (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_account_id uuid references public.source_accounts(id) on delete cascade,
  external_album_id text,
  name text not null,
  cover_asset_id uuid references public.assets(id) on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists public.asset_album_memberships (
  album_id uuid not null references public.asset_albums(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  primary key (album_id, asset_id)
);

-- ============================================================================
-- DERIVED MEDIA (only what we generated, only what's cacheable)
-- ============================================================================
create table if not exists public.asset_thumbnails (
  asset_id uuid not null references public.assets(id) on delete cascade,
  size int not null,                            -- 256, 512, 1024
  storage_key text not null,                    -- supabase storage path
  bytes int,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  primary key (asset_id, size)
);

-- ============================================================================
-- SEARCH / AI
-- ============================================================================
create table if not exists public.asset_ocr (
  asset_id uuid primary key references public.assets(id) on delete cascade,
  user_id uuid not null,
  text text,
  lang text,
  created_at timestamptz not null default now()
);
create index if not exists idx_ocr_user on public.asset_ocr(user_id);

create table if not exists public.asset_labels (
  asset_id uuid not null references public.assets(id) on delete cascade,
  user_id uuid not null,
  label text not null,
  score real,
  primary key (asset_id, label)
);
create index if not exists idx_labels_user_label on public.asset_labels(user_id, label);

create table if not exists public.asset_captions (
  asset_id uuid primary key references public.assets(id) on delete cascade,
  user_id uuid not null,
  caption text,
  model text,
  created_at timestamptz not null default now()
);

create table if not exists public.asset_embeddings (
  asset_id uuid primary key references public.assets(id) on delete cascade,
  user_id uuid not null,
  embedding vector(1536) not null,
  model text not null default 'text-embedding-3-small',
  created_at timestamptz not null default now()
);
-- HNSW for cosine similarity
create index if not exists idx_embeddings_hnsw on public.asset_embeddings
  using hnsw (embedding vector_cosine_ops);
create index if not exists idx_embeddings_user on public.asset_embeddings(user_id);

create table if not exists public.asset_search_documents (
  asset_id uuid primary key references public.assets(id) on delete cascade,
  user_id uuid not null,
  tsv tsvector not null,
  updated_at timestamptz not null default now()
);
create index if not exists idx_search_docs_tsv on public.asset_search_documents using gin (tsv);
create index if not exists idx_search_docs_user on public.asset_search_documents(user_id);

create table if not exists public.search_queries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  raw_query text not null,
  parsed jsonb,
  result_count int,
  took_ms int,
  created_at timestamptz not null default now()
);
create index if not exists idx_search_queries_user on public.search_queries(user_id, created_at desc);

-- ============================================================================
-- ORGANIZATION
-- ============================================================================
create table if not exists public.places (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text,
  city text, region text, country text,
  centroid geography(point, 4326),
  radius_m int,
  created_at timestamptz not null default now()
);
create index if not exists idx_places_user on public.places(user_id);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  family_id uuid references public.families(id) on delete set null,
  title text,
  start_time timestamptz,
  end_time timestamptz,
  place_id uuid references public.places(id) on delete set null,
  confidence real,
  signals jsonb,                                  -- explainability
  generated_summary text,
  visibility asset_visibility not null default 'private',
  created_at timestamptz not null default now()
);
create index if not exists idx_events_user_time on public.events(user_id, start_time desc);

create table if not exists public.event_assets (
  event_id uuid not null references public.events(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  primary key (event_id, asset_id)
);

create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  family_id uuid references public.families(id) on delete set null,
  display_name text,
  is_minor boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_people_user on public.people(user_id);

create table if not exists public.person_faces (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  user_id uuid not null,
  person_id uuid references public.people(id) on delete set null,
  bbox jsonb,
  face_embedding vector(512),
  confidence real,
  created_at timestamptz not null default now()
);
create index if not exists idx_faces_user on public.person_faces(user_id);
create index if not exists idx_faces_person on public.person_faces(person_id);

create table if not exists public.duplicate_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  signal text not null,                           -- sha256|phash|embedding
  confidence real,
  primary_asset_id uuid references public.assets(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_dgroups_user on public.duplicate_groups(user_id);

create table if not exists public.timeline_windows (
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket date not null,
  asset_count int not null default 0,
  first_asset_id uuid,
  last_asset_id uuid,
  payload jsonb,                                  -- top-N viewport descriptors
  refreshed_at timestamptz not null default now(),
  primary key (user_id, bucket)
);
create index if not exists idx_timeline_user on public.timeline_windows(user_id, bucket desc);

create table if not exists public.smart_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,                             -- trips|birthdays|screenshots|...
  name text not null,
  rules jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.user_corrections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,                             -- dedupe|event|person|place
  payload jsonb not null,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- MEMORY GRAPH FOUNDATION
-- ============================================================================
create table if not exists public.memory_nodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,                             -- asset|person|place|event|source|device|album|collection
  ref_id uuid,
  attrs jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_nodes_user_kind on public.memory_nodes(user_id, kind);

create table if not exists public.memory_edges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  src uuid not null references public.memory_nodes(id) on delete cascade,
  dst uuid not null references public.memory_nodes(id) on delete cascade,
  kind text not null,
  weight real,
  attrs jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_edges_user_src on public.memory_edges(user_id, src, kind);
create index if not exists idx_edges_user_dst on public.memory_edges(user_id, dst, kind);

-- ============================================================================
-- OBSERVABILITY
-- ============================================================================
create table if not exists public.audit_logs (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target text,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_user on public.audit_logs(user_id, created_at desc);

create table if not exists public.ingestion_events (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  source_account_id uuid references public.source_accounts(id) on delete cascade,
  kind text not null,                             -- batch|asset|dedupe|ai|timeline
  stats jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- GRANTS (REQUIRED — Supabase Data API needs explicit grants)
-- ============================================================================
grant select, insert, update, delete on public.user_profiles to authenticated;
grant select, insert, update, delete on public.privacy_settings to authenticated;
grant select, insert on public.consent_records to authenticated;
grant select on public.user_roles to authenticated;
grant select on public.source_providers to authenticated, anon;
grant select, insert, update, delete on public.source_accounts to authenticated;
grant select on public.source_sync_cursors to authenticated;
grant select on public.source_sync_jobs to authenticated;
grant select on public.source_errors to authenticated;
grant select, insert, update, delete on public.assets to authenticated;
grant select on public.asset_source_refs to authenticated;
grant select on public.asset_exif to authenticated;
grant select on public.asset_albums to authenticated;
grant select on public.asset_album_memberships to authenticated;
grant select on public.asset_thumbnails to authenticated;
grant select on public.asset_ocr to authenticated;
grant select on public.asset_labels to authenticated;
grant select on public.asset_captions to authenticated;
grant select on public.asset_embeddings to authenticated;
grant select on public.asset_search_documents to authenticated;
grant select, insert on public.search_queries to authenticated;
grant select on public.places to authenticated;
grant select on public.events to authenticated;
grant select on public.event_assets to authenticated;
grant select on public.people to authenticated;
grant select on public.person_faces to authenticated;
grant select on public.duplicate_groups to authenticated;
grant select on public.timeline_windows to authenticated;
grant select, insert, update, delete on public.smart_collections to authenticated;
grant select, insert on public.user_corrections to authenticated;
grant select on public.memory_nodes to authenticated;
grant select on public.memory_edges to authenticated;
grant select on public.audit_logs to authenticated;
grant select, insert, update, delete on public.families to authenticated;
grant select, insert, update, delete on public.family_members to authenticated;
grant select, insert, update, delete on public.family_invitations to authenticated;

grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- service_role only for tokens
revoke all on public.source_tokens from anon, authenticated;
grant all on public.source_tokens to service_role;

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
alter table public.user_roles enable row level security;
alter table public.user_profiles enable row level security;
alter table public.privacy_settings enable row level security;
alter table public.consent_records enable row level security;
alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.family_invitations enable row level security;
alter table public.source_providers enable row level security;
alter table public.source_accounts enable row level security;
alter table public.source_tokens enable row level security;
alter table public.source_sync_cursors enable row level security;
alter table public.source_sync_jobs enable row level security;
alter table public.source_errors enable row level security;
alter table public.assets enable row level security;
alter table public.asset_source_refs enable row level security;
alter table public.asset_exif enable row level security;
alter table public.asset_albums enable row level security;
alter table public.asset_album_memberships enable row level security;
alter table public.asset_thumbnails enable row level security;
alter table public.asset_ocr enable row level security;
alter table public.asset_labels enable row level security;
alter table public.asset_captions enable row level security;
alter table public.asset_embeddings enable row level security;
alter table public.asset_search_documents enable row level security;
alter table public.search_queries enable row level security;
alter table public.places enable row level security;
alter table public.events enable row level security;
alter table public.event_assets enable row level security;
alter table public.people enable row level security;
alter table public.person_faces enable row level security;
alter table public.duplicate_groups enable row level security;
alter table public.timeline_windows enable row level security;
alter table public.smart_collections enable row level security;
alter table public.user_corrections enable row level security;
alter table public.memory_nodes enable row level security;
alter table public.memory_edges enable row level security;
alter table public.audit_logs enable row level security;
alter table public.ingestion_events enable row level security;

-- Helper: own row policies
do $$ declare t text;
begin
  for t in
    select unnest(array[
      'user_profiles','privacy_settings','source_accounts','source_sync_cursors',
      'source_sync_jobs','source_errors','asset_source_refs','asset_exif',
      'asset_albums','asset_thumbnails','asset_ocr','asset_labels','asset_captions',
      'asset_embeddings','asset_search_documents','search_queries','places',
      'people','person_faces','duplicate_groups','timeline_windows',
      'smart_collections','user_corrections','memory_nodes','memory_edges',
      'ingestion_events','consent_records','audit_logs','user_roles'
    ])
  loop
    execute format('drop policy if exists own_select on public.%I', t);
    execute format('create policy own_select on public.%I for select to authenticated using (user_id = auth.uid())', t);
    execute format('drop policy if exists own_modify on public.%I', t);
    execute format('create policy own_modify on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- Assets: own + family-visible
drop policy if exists assets_select on public.assets;
create policy assets_select on public.assets for select to authenticated using (
  user_id = auth.uid()
  or (visibility in ('family','shared') and family_id is not null
      and public.is_family_member(auth.uid(), family_id))
);
drop policy if exists assets_modify on public.assets;
create policy assets_modify on public.assets for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Events: same pattern
drop policy if exists events_select on public.events;
create policy events_select on public.events for select to authenticated using (
  user_id = auth.uid()
  or (visibility in ('family','shared') and family_id is not null
      and public.is_family_member(auth.uid(), family_id))
);
drop policy if exists events_modify on public.events;
create policy events_modify on public.events for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Event assets: visible if the parent event is visible
drop policy if exists event_assets_select on public.event_assets;
create policy event_assets_select on public.event_assets for select to authenticated using (
  exists (select 1 from public.events e where e.id = event_id
          and (e.user_id = auth.uid()
               or (e.visibility in ('family','shared') and e.family_id is not null
                   and public.is_family_member(auth.uid(), e.family_id))))
);

-- Families
drop policy if exists families_select on public.families;
create policy families_select on public.families for select to authenticated
  using (owner_id = auth.uid() or public.is_family_member(auth.uid(), id));
drop policy if exists families_modify on public.families;
create policy families_modify on public.families for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists family_members_select on public.family_members;
create policy family_members_select on public.family_members for select to authenticated
  using (user_id = auth.uid() or public.is_family_member(auth.uid(), family_id));
drop policy if exists family_members_modify on public.family_members;
create policy family_members_modify on public.family_members for all to authenticated
  using (exists (select 1 from public.families f where f.id = family_id and f.owner_id = auth.uid()))
  with check (exists (select 1 from public.families f where f.id = family_id and f.owner_id = auth.uid()));

drop policy if exists family_invitations_select on public.family_invitations;
create policy family_invitations_select on public.family_invitations for select to authenticated
  using (invited_by = auth.uid()
      or exists (select 1 from public.families f where f.id = family_id and f.owner_id = auth.uid()));
drop policy if exists family_invitations_modify on public.family_invitations;
create policy family_invitations_modify on public.family_invitations for all to authenticated
  using (exists (select 1 from public.families f where f.id = family_id and f.owner_id = auth.uid()))
  with check (exists (select 1 from public.families f where f.id = family_id and f.owner_id = auth.uid()));

-- Source providers: read-only for everyone (catalog)
drop policy if exists providers_select on public.source_providers;
create policy providers_select on public.source_providers for select to authenticated, anon using (true);

-- ============================================================================
-- TRIGGERS
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_profiles(user_id, display_name)
    values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)))
    on conflict (user_id) do nothing;
  insert into public.privacy_settings(user_id) values (new.id) on conflict (user_id) do nothing;
  insert into public.user_roles(user_id, role) values (new.id, 'user') on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists assets_touch on public.assets;
create trigger assets_touch before update on public.assets
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- VIEWPORT MATERIALIZATION HELPER
-- ============================================================================
create or replace function public.refresh_timeline_window(_user uuid, _bucket date)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.timeline_windows where user_id = _user and bucket = _bucket;
  insert into public.timeline_windows(user_id, bucket, asset_count, first_asset_id, last_asset_id, payload)
  select _user, _bucket, count(*)::int,
         (array_agg(id order by capture_time asc))[1],
         (array_agg(id order by capture_time desc))[1],
         jsonb_agg(jsonb_build_object(
           'asset_id', id, 'capture_time', capture_time,
           'w', width, 'h', height,
           'blurhash', blurhash, 'dominant_color', dominant_color
         ) order by capture_time desc)
  from public.assets
  where user_id = _user
    and deleted_at is null
    and capture_time >= _bucket::timestamptz
    and capture_time <  (_bucket + 1)::timestamptz;
end $$;

-- ============================================================================
-- DASHBOARD VIEW
-- ============================================================================
create or replace view public.dashboard_counts with (security_invoker = true) as
select
  a.user_id,
  count(*)::bigint as total_assets,
  count(*) filter (where a.media_type = 'video')::bigint as total_videos,
  count(distinct r.source_account_id)::bigint as connected_sources,
  count(*) filter (where a.duplicate_group_id is not null)::bigint as in_duplicate_groups,
  count(*) filter (where (select count(*) from public.asset_source_refs r2 where r2.asset_id = a.id) = 1)::bigint as at_risk_count
from public.assets a
left join public.asset_source_refs r on r.asset_id = a.id
where a.deleted_at is null
group by a.user_id;

grant select on public.dashboard_counts to authenticated;

-- DONE.