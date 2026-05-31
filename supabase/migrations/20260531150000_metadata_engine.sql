-- Universal Metadata Extraction & Indexing Engine — Batch 1
-- Adds: scan_* tables, asset_file/media/gps/xmp_iptc/video/document/audio/hashes/preview/ai_ready/organization_signals
-- Augments: asset_exif, asset_source_refs, source_accounts
-- Reuses: assets, asset_search_documents

-- =========================================================================
-- 1. SCAN SESSION TABLES
-- =========================================================================

create table if not exists public.scan_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  family_id uuid references public.families(id) on delete set null,
  source_account_id uuid references public.source_accounts(id) on delete cascade,
  source_kind text not null,
  root_path_or_source_ref text not null,
  scan_mode text not null default 'full' check (scan_mode in ('full','incremental','resume')),
  status text not null default 'pending' check (status in ('pending','running','paused','cancelled','completed','failed')),
  phase text not null default 'queued',
  include_hidden boolean not null default false,
  follow_symlinks boolean not null default false,
  max_depth int,
  enable_hashing boolean not null default true,
  enable_perceptual_hash boolean not null default true,
  enable_video_fingerprint boolean not null default false,
  enable_document_text_extraction boolean not null default false,
  enable_ocr_preparation boolean not null default false,
  enable_ai_enrichment boolean not null default false,
  enable_face_processing boolean not null default false,
  ai_processing_consent boolean not null default false,
  face_processing_consent boolean not null default false,
  batch_size int not null default 200,
  concurrency int not null default 4,
  discovered_files bigint not null default 0,
  supported_files bigint not null default 0,
  processed_files bigint not null default 0,
  skipped_files bigint not null default 0,
  error_files bigint not null default 0,
  current_path_redacted text,
  cancellation_requested boolean not null default false,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_scan_sessions_user on public.scan_sessions(user_id, created_at desc);
create index if not exists idx_scan_sessions_status on public.scan_sessions(user_id, status);
create index if not exists idx_scan_sessions_source on public.scan_sessions(source_account_id);
create trigger trg_scan_sessions_updated before update on public.scan_sessions for each row execute function public.set_updated_at();

create table if not exists public.scan_roots (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scan_sessions(id) on delete cascade,
  user_id uuid not null,
  root_label text,
  root_path_redacted text,
  root_path_hash text,
  created_at timestamptz not null default now()
);
create index if not exists idx_scan_roots_scan on public.scan_roots(scan_id);

create table if not exists public.scan_checkpoints (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scan_sessions(id) on delete cascade,
  user_id uuid not null,
  checkpoint_type text not null default 'auto',
  directory_queue jsonb not null default '[]'::jsonb,
  provider_cursor text,
  last_processed_path text,
  last_processed_source_asset_id text,
  batch_sequence int not null default 0,
  current_phase text,
  checkpoint_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_scan_checkpoints_scan on public.scan_checkpoints(scan_id, created_at desc);
create trigger trg_scan_checkpoints_updated before update on public.scan_checkpoints for each row execute function public.set_updated_at();

create table if not exists public.scan_batches (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scan_sessions(id) on delete cascade,
  user_id uuid not null,
  batch_sequence int not null,
  asset_count int not null default 0,
  status text not null default 'pending' check (status in ('pending','processing','completed','failed')),
  idempotency_key text,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(scan_id, batch_sequence)
);
create index if not exists idx_scan_batches_scan on public.scan_batches(scan_id, batch_sequence);
create unique index if not exists uq_scan_batches_idem on public.scan_batches(scan_id, idempotency_key) where idempotency_key is not null;

create table if not exists public.scan_errors (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scan_sessions(id) on delete cascade,
  user_id uuid not null,
  source_account_id uuid references public.source_accounts(id) on delete set null,
  source_asset_id text,
  file_path_redacted text,
  error_code text not null,
  error_message text not null,
  error_stage text not null,
  is_fatal boolean not null default false,
  raw_error jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_scan_errors_scan on public.scan_errors(scan_id, created_at desc);
create index if not exists idx_scan_errors_user on public.scan_errors(user_id, created_at desc);
create index if not exists idx_scan_errors_code on public.scan_errors(scan_id, error_code);

-- =========================================================================
-- 2. ASSET METADATA TABLES
-- =========================================================================

create table if not exists public.asset_file_metadata (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  absolute_path_redacted text,
  normalized_absolute_path_hash text,
  relative_path text,
  parent_folder_path text,
  root_path_hash text,
  folder_depth int,
  filename text,
  filename_without_extension text,
  extension text,
  normalized_extension text,
  detected_file_type text,
  file_size_bytes bigint,
  created_at_filesystem timestamptz,
  modified_at_filesystem timestamptz,
  accessed_at_filesystem timestamptz,
  inode text,
  device_id text,
  permissions_readable boolean,
  permissions_writable boolean,
  is_hidden boolean,
  is_symlink boolean,
  symlink_target_redacted text,
  scan_discovered_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_afm_user on public.asset_file_metadata(user_id);
create index if not exists idx_afm_path_hash on public.asset_file_metadata(user_id, normalized_absolute_path_hash);
create index if not exists idx_afm_modified on public.asset_file_metadata(user_id, modified_at_filesystem desc);

create table if not exists public.asset_media_metadata (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  width int, height int,
  aspect_ratio numeric,
  orientation text,
  duration_ms bigint,
  frame_rate numeric,
  bit_depth int,
  color_profile text,
  color_space text,
  has_alpha boolean,
  has_audio boolean,
  has_video boolean,
  page_count int,
  word_count int,
  slide_count int,
  sheet_count int,
  encoding text,
  language text,
  thumbnail_possible boolean,
  preview_possible boolean,
  ai_processing_possible boolean,
  ocr_possible boolean,
  created_at timestamptz not null default now()
);
create index if not exists idx_amm_user on public.asset_media_metadata(user_id);

alter table public.asset_exif
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists exif_make text,
  add column if not exists exif_model text,
  add column if not exists lens_make text,
  add column if not exists lens_model text,
  add column if not exists focal_length_35mm numeric,
  add column if not exists f_number numeric,
  add column if not exists exposure_time text,
  add column if not exists exposure_mode text,
  add column if not exists metering_mode text,
  add column if not exists software text,
  add column if not exists image_unique_id text,
  add column if not exists orientation text,
  add column if not exists exif_capture_time timestamptz,
  add column if not exists exif_original_time timestamptz,
  add column if not exists exif_digitized_time timestamptz,
  add column if not exists timezone_offset text,
  add column if not exists artist text,
  add column if not exists copyright text,
  add column if not exists image_description text;
create index if not exists idx_asset_exif_user on public.asset_exif(user_id);

create table if not exists public.asset_gps (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  gps_latitude numeric,
  gps_longitude numeric,
  gps_altitude numeric,
  gps_timestamp timestamptz,
  gps_direction numeric,
  gps_speed numeric,
  location_source text,
  location_confidence numeric,
  geohash text,
  reverse_geocoded_city text,
  reverse_geocoded_state text,
  reverse_geocoded_country text,
  reverse_geocoded_country_code text,
  place_name text,
  timezone_from_location text,
  created_at timestamptz not null default now()
);
create index if not exists idx_asset_gps_user on public.asset_gps(user_id);
create index if not exists idx_asset_gps_geohash on public.asset_gps(geohash) where geohash is not null;
create index if not exists idx_asset_gps_country on public.asset_gps(user_id, reverse_geocoded_country_code);

create table if not exists public.asset_xmp_iptc (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  xmp_title text, xmp_description text, xmp_creator text, xmp_rights text,
  xmp_keywords text[], xmp_rating int,
  iptc_caption text, iptc_headline text, iptc_keywords text[],
  iptc_byline text, iptc_credit text, iptc_source text,
  iptc_city text, iptc_state text, iptc_country text,
  iptc_subject_codes text[],
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_axi_user on public.asset_xmp_iptc(user_id);
create index if not exists idx_axi_kw on public.asset_xmp_iptc using gin (xmp_keywords);

create table if not exists public.asset_video_metadata (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  video_codec text, video_bitrate bigint,
  audio_codec text, audio_bitrate bigint,
  audio_channels int, audio_sample_rate int,
  rotation int, has_hdr boolean, container_format text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_avm_user on public.asset_video_metadata(user_id);

create table if not exists public.asset_document_metadata (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  doc_title text, doc_author text, doc_subject text,
  doc_keywords text[], doc_producer text, doc_creator_tool text,
  page_count int, word_count int, language text,
  has_text_layer boolean, is_encrypted boolean,
  doc_created_at timestamptz, doc_modified_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_adm_user on public.asset_document_metadata(user_id);
create index if not exists idx_adm_keywords on public.asset_document_metadata using gin (doc_keywords);

create table if not exists public.asset_audio_metadata (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text, artist text, album text, album_artist text, composer text,
  genre text, track_number int, disc_number int, year int,
  duration_ms bigint, bitrate bigint, sample_rate int, channels int,
  codec text, has_cover_art boolean,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_aam_user on public.asset_audio_metadata(user_id);

create table if not exists public.asset_hashes (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  file_hash_sha256 text, quick_hash text, partial_hash text,
  perceptual_hash_image text, video_fingerprint text,
  audio_fingerprint text, text_hash text,
  hash_algorithm text,
  hash_status text not null default 'pending' check (hash_status in ('pending','partial','complete','error','skipped')),
  hash_error text,
  hash_created_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_ah_user on public.asset_hashes(user_id);
create index if not exists idx_ah_sha256 on public.asset_hashes(file_hash_sha256) where file_hash_sha256 is not null;
create index if not exists idx_ah_phash on public.asset_hashes(perceptual_hash_image) where perceptual_hash_image is not null;
create index if not exists idx_ah_quick on public.asset_hashes(quick_hash) where quick_hash is not null;

create table if not exists public.asset_preview_metadata (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  blurhash text, dominant_color text, palette jsonb,
  thumbnail_generated boolean not null default false,
  preview_generated boolean not null default false,
  thumbnail_cache_key text, preview_cache_key text,
  created_at timestamptz not null default now()
);
create index if not exists idx_apm_user on public.asset_preview_metadata(user_id);

create table if not exists public.asset_ai_ready_metadata (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ai_processing_possible boolean not null default false,
  ai_processing_consent boolean not null default false,
  ocr_possible boolean not null default false,
  ocr_status text not null default 'pending',
  caption_status text not null default 'pending',
  labels_status text not null default 'pending',
  embedding_status text not null default 'pending',
  face_processing_possible boolean not null default false,
  face_processing_consent boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_aarm_user on public.asset_ai_ready_metadata(user_id);
create trigger trg_aarm_updated before update on public.asset_ai_ready_metadata for each row execute function public.set_updated_at();

create table if not exists public.asset_organization_signals (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  folder_tokens text[], filename_tokens text[],
  date_hint date, year_hint int, month_hint int,
  event_hint text, album_hint text, trip_hint text,
  people_hint text[],
  duplicate_status text, duplicate_group_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists idx_aos_user on public.asset_organization_signals(user_id);
create index if not exists idx_aos_date on public.asset_organization_signals(user_id, date_hint);
create index if not exists idx_aos_folder on public.asset_organization_signals using gin (folder_tokens);

alter table public.asset_source_refs
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists source_kind text,
  add column if not exists source_provider text,
  add column if not exists source_uri text,
  add column if not exists source_relative_path text,
  add column if not exists provider_revision_id text,
  add column if not exists provider_etag text,
  add column if not exists provider_content_hash text,
  add column if not exists provider_thumbnail_url text,
  add column if not exists provider_web_url text,
  add column if not exists provider_download_url text,
  add column if not exists source_created_at timestamptz,
  add column if not exists source_modified_at timestamptz,
  add column if not exists source_uploaded_at timestamptz,
  add column if not exists source_last_seen_at timestamptz default now(),
  add column if not exists source_deleted boolean not null default false,
  add column if not exists source_availability text not null default 'available',
  add column if not exists source_permission_state text not null default 'granted';
create index if not exists idx_asr_user on public.asset_source_refs(user_id);
create index if not exists idx_asr_source_kind on public.asset_source_refs(source_account_id, source_kind);

alter table public.source_accounts
  add column if not exists source_kind text;

-- =========================================================================
-- 3. GRANTS
-- =========================================================================

grant select, insert, update, delete on public.scan_sessions    to authenticated;
grant select, insert, update, delete on public.scan_roots       to authenticated;
grant select, insert, update, delete on public.scan_checkpoints to authenticated;
grant select, insert, update, delete on public.scan_batches     to authenticated;
grant select, insert, update, delete on public.scan_errors      to authenticated;
grant select on public.asset_file_metadata        to authenticated;
grant select on public.asset_media_metadata       to authenticated;
grant select on public.asset_gps                  to authenticated;
grant select on public.asset_xmp_iptc             to authenticated;
grant select on public.asset_video_metadata       to authenticated;
grant select on public.asset_document_metadata    to authenticated;
grant select on public.asset_audio_metadata       to authenticated;
grant select on public.asset_hashes               to authenticated;
grant select on public.asset_preview_metadata     to authenticated;
grant select on public.asset_ai_ready_metadata    to authenticated;
grant select on public.asset_organization_signals to authenticated;

grant all on public.scan_sessions    to service_role;
grant all on public.scan_roots       to service_role;
grant all on public.scan_checkpoints to service_role;
grant all on public.scan_batches     to service_role;
grant all on public.scan_errors      to service_role;
grant all on public.asset_file_metadata        to service_role;
grant all on public.asset_media_metadata       to service_role;
grant all on public.asset_gps                  to service_role;
grant all on public.asset_xmp_iptc             to service_role;
grant all on public.asset_video_metadata       to service_role;
grant all on public.asset_document_metadata    to service_role;
grant all on public.asset_audio_metadata       to service_role;
grant all on public.asset_hashes               to service_role;
grant all on public.asset_preview_metadata     to service_role;
grant all on public.asset_ai_ready_metadata    to service_role;
grant all on public.asset_organization_signals to service_role;

-- =========================================================================
-- 4. RLS
-- =========================================================================

alter table public.scan_sessions    enable row level security;
alter table public.scan_roots       enable row level security;
alter table public.scan_checkpoints enable row level security;
alter table public.scan_batches     enable row level security;
alter table public.scan_errors      enable row level security;
alter table public.asset_file_metadata        enable row level security;
alter table public.asset_media_metadata       enable row level security;
alter table public.asset_gps                  enable row level security;
alter table public.asset_xmp_iptc             enable row level security;
alter table public.asset_video_metadata       enable row level security;
alter table public.asset_document_metadata    enable row level security;
alter table public.asset_audio_metadata       enable row level security;
alter table public.asset_hashes               enable row level security;
alter table public.asset_preview_metadata     enable row level security;
alter table public.asset_ai_ready_metadata    enable row level security;
alter table public.asset_organization_signals enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'scan_sessions','scan_roots','scan_checkpoints','scan_batches','scan_errors',
    'asset_file_metadata','asset_media_metadata','asset_gps','asset_xmp_iptc',
    'asset_video_metadata','asset_document_metadata','asset_audio_metadata',
    'asset_hashes','asset_preview_metadata','asset_ai_ready_metadata',
    'asset_organization_signals'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_modify', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id = auth.uid())',
      t || '_owner_select', t
    );
    execute format(
      'create policy %I on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t || '_owner_modify', t
    );
  end loop;
end $$;

-- =========================================================================
-- 5. PROGRESS HELPER
-- =========================================================================

create or replace function public.scan_session_progress(_scan_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'scan_id', s.id,
    'status', s.status,
    'phase', s.phase,
    'discovered_files', s.discovered_files,
    'supported_files', s.supported_files,
    'processed_files', s.processed_files,
    'skipped_files', s.skipped_files,
    'error_files', s.error_files,
    'current_path_redacted', s.current_path_redacted,
    'started_at', s.started_at,
    'updated_at', s.updated_at,
    'percent_complete', case when s.supported_files > 0
      then round((s.processed_files::numeric / s.supported_files::numeric) * 100, 2)
      else null end,
    'cancellation_requested', s.cancellation_requested
  )
  from public.scan_sessions s
  where s.id = _scan_id and s.user_id = auth.uid();
$$;
grant execute on function public.scan_session_progress(uuid) to authenticated;
