-- 0007_organization.sql -- Duplicates, people, places, events, collections, corrections
-- Default face vector dim: 512. person_faces populated ONLY with explicit consent.

create table public.duplicate_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  confidence numeric,
  recommended_primary_asset_id uuid references public.assets(id) on delete set null,
  storage_risk text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.duplicate_groups is 'Cluster of likely-duplicate assets for a user.';
create index idx_dup_groups_user on public.duplicate_groups(user_id);
create trigger trg_dup_groups_updated before update on public.duplicate_groups for each row execute function public.set_updated_at();

create table public.duplicate_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.duplicate_groups(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  match_type dup_match_type not null,
  score numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(group_id, asset_id)
);
comment on table public.duplicate_group_members is 'Membership of assets in a duplicate group.';
create index idx_dup_members_asset on public.duplicate_group_members(asset_id);
create trigger trg_dup_members_updated before update on public.duplicate_group_members for each row execute function public.set_updated_at();

create table public.people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  family_id uuid references public.families(id) on delete set null,
  display_name text,
  is_child boolean not null default false,
  is_elder boolean not null default false,
  consent_required boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_id is not null or family_id is not null)
);
comment on table public.people is 'A person known to a user/family (biometric-consent gated).';
create index idx_people_user on public.people(user_id);
create index idx_people_family on public.people(family_id);
create trigger trg_people_updated before update on public.people for each row execute function public.set_updated_at();

create table public.person_faces (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  face_vector vector(512),
  bbox jsonb,
  confidence numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.person_faces is 'Biometric face vectors. Populated only with face_recognition consent.';
create index idx_person_faces_person on public.person_faces(person_id);
create index idx_person_faces_asset on public.person_faces(asset_id);
create index idx_person_faces_hnsw on public.person_faces using hnsw (face_vector vector_cosine_ops) with (m = 16, ef_construction = 64);
create trigger trg_person_faces_updated before update on public.person_faces for each row execute function public.set_updated_at();

create table public.face_clusters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cluster_label text,
  person_id uuid references public.people(id) on delete set null,
  size int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.face_clusters is 'Unsupervised face clusters; may be promoted to person_id.';
create index idx_face_clusters_user on public.face_clusters(user_id);
create trigger trg_face_clusters_updated before update on public.face_clusters for each row execute function public.set_updated_at();

create table public.places (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  family_id uuid references public.families(id) on delete set null,
  name text not null,
  lat double precision, lng double precision,
  radius_m int,
  kind text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_id is not null or family_id is not null)
);
comment on table public.places is 'Named places that anchor memories.';
create index idx_places_user on public.places(user_id);
create index idx_places_family on public.places(family_id);
create trigger trg_places_updated before update on public.places for each row execute function public.set_updated_at();

create table public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  family_id uuid references public.families(id) on delete set null,
  title text,
  start_time timestamptz,
  end_time timestamptz,
  place_id uuid references public.places(id) on delete set null,
  confidence numeric,
  summary text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_id is not null or family_id is not null)
);
comment on table public.events is 'Memory events (e.g. trips, gatherings).';
create index idx_events_user_time on public.events(user_id, start_time desc);
create index idx_events_family on public.events(family_id);
create trigger trg_events_updated before update on public.events for each row execute function public.set_updated_at();

create table public.event_assets (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  unique(event_id, asset_id)
);
comment on table public.event_assets is 'Assets that belong to an event.';
create index idx_event_assets_asset on public.event_assets(asset_id);

create table public.event_people (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  unique(event_id, person_id)
);
comment on table public.event_people is 'People associated to an event.';

create table public.event_places (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete cascade,
  unique(event_id, place_id)
);
comment on table public.event_places is 'Places associated to an event.';

create table public.timeline_windows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  granularity text not null check (granularity in ('year','month','day','event')),
  bucket text not null,
  asset_ids uuid[] not null default '{}',
  asset_count int not null default 0,
  start_time timestamptz,
  end_time timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, granularity, bucket)
);
comment on table public.timeline_windows is 'Precomputed viewport pages for sub-50ms reads.';
create index idx_timeline_windows_user on public.timeline_windows(user_id, granularity, bucket);
create trigger trg_timeline_windows_updated before update on public.timeline_windows for each row execute function public.set_updated_at();

create table public.smart_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  family_id uuid references public.families(id) on delete set null,
  kind text not null,
  name text not null,
  rule jsonb not null default '{}'::jsonb,
  dynamic boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_id is not null or family_id is not null)
);
comment on table public.smart_collections is 'Rule-based or manual collections of assets.';
create index idx_smart_collections_user on public.smart_collections(user_id);
create trigger trg_smart_collections_updated before update on public.smart_collections for each row execute function public.set_updated_at();

create table public.collection_assets (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.smart_collections(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  unique(collection_id, asset_id)
);
comment on table public.collection_assets is 'Asset membership in collections.';
create index idx_collection_assets_asset on public.collection_assets(asset_id);

create table public.user_corrections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null,
  target_id uuid not null,
  correction jsonb not null,
  created_at timestamptz not null default now()
);
comment on table public.user_corrections is 'User feedback to retrain clustering/dedup/people.';
create index idx_user_corrections_user on public.user_corrections(user_id, created_at desc);
