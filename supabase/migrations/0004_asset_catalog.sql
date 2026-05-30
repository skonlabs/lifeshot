-- 0004_asset_catalog.sql -- Canonical assets and per-source refs

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  family_id uuid references public.families(id) on delete set null,
  media_type media_type not null default 'photo',
  mime_type text,
  capture_time timestamptz,
  capture_time_confidence numeric,
  upload_time timestamptz,
  created_time timestamptz,
  modified_time timestamptz,
  timezone text,
  width int,
  height int,
  duration_ms int,
  file_size_bytes bigint,
  checksum_hash text,
  perceptual_hash text,
  video_fingerprint text,
  source_count int not null default 0,
  primary_source_ref_id uuid,
  thumbnail_cache_key text,
  proxy_cache_key text,
  blurhash text,
  dominant_color text,
  location_lat double precision,
  location_lng double precision,
  location_city text,
  location_country text,
  location_confidence numeric,
  device_make text,
  device_model text,
  quality_score numeric,
  duplicate_group_id uuid,
  event_id uuid,
  place_id uuid,
  embedding_id uuid,
  memory_node_id uuid,
  visibility_state visibility_state not null default 'private',
  deleted_state deleted_state not null default 'active',
  permission_state permission_state not null default 'owner',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.assets is 'Canonical asset row; one logical photo/video regardless of source count.';
create index idx_assets_user_capture on public.assets(user_id, capture_time desc);
create index idx_assets_user_state on public.assets(user_id, deleted_state, visibility_state);
create index idx_assets_perceptual_hash on public.assets(perceptual_hash) where perceptual_hash is not null;
create index idx_assets_checksum on public.assets(checksum_hash) where checksum_hash is not null;
create index idx_assets_duplicate_group on public.assets(duplicate_group_id) where duplicate_group_id is not null;
create index idx_assets_event on public.assets(event_id) where event_id is not null;
create index idx_assets_place on public.assets(place_id) where place_id is not null;
create index idx_assets_family on public.assets(family_id) where family_id is not null;
create index idx_assets_device_model_trgm on public.assets using gin (device_model gin_trgm_ops) where device_model is not null;
create trigger trg_assets_updated before update on public.assets for each row execute function public.set_updated_at();

create table public.asset_source_refs (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  source_account_id uuid not null references public.source_accounts(id) on delete cascade,
  source_asset_id text not null,
  provider_url text,
  match_confidence numeric,
  is_primary boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_account_id, source_asset_id)
);
comment on table public.asset_source_refs is 'Per-source pointer to an asset; many refs per asset are expected.';
create index idx_asset_source_refs_asset on public.asset_source_refs(asset_id);
create index idx_asset_source_refs_account on public.asset_source_refs(source_account_id);
create trigger trg_asset_source_refs_updated before update on public.asset_source_refs for each row execute function public.set_updated_at();

-- Maintain assets.source_count
create or replace function public.recalc_asset_source_count()
returns trigger language plpgsql as $$
declare _aid uuid;
begin
  _aid := coalesce(new.asset_id, old.asset_id);
  update public.assets a
     set source_count = (select count(*) from public.asset_source_refs where asset_id = _aid)
   where a.id = _aid;
  return null;
end;
$$;
create trigger trg_asset_source_refs_count
after insert or delete or update on public.asset_source_refs
for each row execute function public.recalc_asset_source_count();

create table public.asset_metadata (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  raw jsonb not null default '{}'::jsonb,
  normalized jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.asset_metadata is 'Raw + normalized provider metadata for an asset.';
create trigger trg_asset_metadata_updated before update on public.asset_metadata for each row execute function public.set_updated_at();

create table public.asset_exif (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  camera_make text, camera_model text, lens text,
  iso int, aperture numeric, shutter_speed text, focal_length numeric,
  exposure_program text, white_balance text, flash text,
  gps jsonb, raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.asset_exif is 'Parsed EXIF for an asset.';
create trigger trg_asset_exif_updated before update on public.asset_exif for each row execute function public.set_updated_at();

create table public.asset_locations (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  lat double precision, lng double precision,
  city text, country text, region text,
  confidence numeric, geocoded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.asset_locations is 'Reverse-geocoded location data for an asset.';
create index idx_asset_locations_city on public.asset_locations(city);
create trigger trg_asset_locations_updated before update on public.asset_locations for each row execute function public.set_updated_at();

create table public.asset_devices (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  make text, model text, os text, device_hint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.asset_devices is 'Capture-device info for an asset.';
create trigger trg_asset_devices_updated before update on public.asset_devices for each row execute function public.set_updated_at();

create table public.asset_albums (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid not null references public.source_accounts(id) on delete cascade,
  source_album_id text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_account_id, source_album_id)
);
comment on table public.asset_albums is 'Albums mirrored from sources.';
create trigger trg_asset_albums_updated before update on public.asset_albums for each row execute function public.set_updated_at();

create table public.asset_album_memberships (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  album_id uuid not null references public.asset_albums(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(asset_id, album_id)
);
comment on table public.asset_album_memberships is 'Asset<->album link.';
create index idx_album_memb_album on public.asset_album_memberships(album_id);
create trigger trg_asset_album_memb_updated before update on public.asset_album_memberships for each row execute function public.set_updated_at();

create table public.asset_quality_scores (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  sharpness numeric, exposure numeric, aesthetic numeric, salience numeric,
  quality_score numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.asset_quality_scores is 'ML-derived quality signals for ranking.';
create trigger trg_asset_quality_updated before update on public.asset_quality_scores for each row execute function public.set_updated_at();

create table public.asset_visibility (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  visibility_state visibility_state not null default 'private',
  family_id uuid references public.families(id) on delete set null,
  shared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.asset_visibility is 'Explicit per-asset sharing record (opt-in).';
create index idx_asset_visibility_family on public.asset_visibility(family_id) where family_id is not null;
create trigger trg_asset_visibility_updated before update on public.asset_visibility for each row execute function public.set_updated_at();
