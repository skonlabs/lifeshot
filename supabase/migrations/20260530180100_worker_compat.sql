-- Compatibility migration: tables/columns referenced by the worker layer.

alter table public.assets
  add column if not exists status text not null default 'ingested',
  add column if not exists local_time timestamptz,
  add column if not exists place_name text,
  add column if not exists place_id_text text;

alter table public.source_accounts
  add column if not exists provider_kind text,
  add column if not exists access_token text,
  add column if not exists refresh_token text,
  add column if not exists expires_at timestamptz,
  add column if not exists last_synced_at timestamptz;

update public.source_accounts sa
   set provider_kind = sp.kind
  from public.source_providers sp
 where sa.provider_id = sp.id and sa.provider_kind is null;

create table if not exists public.asset_derivatives (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  kind text not null,
  storage_bucket text not null,
  storage_path text not null,
  mime_type text,
  blurhash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(asset_id, kind)
);
grant select, insert on public.asset_derivatives to authenticated;
grant all on public.asset_derivatives to service_role;
alter table public.asset_derivatives enable row level security;
create policy asset_derivatives_owner on public.asset_derivatives
  for select to authenticated
  using (exists (select 1 from public.assets a where a.id = asset_id and a.user_id = auth.uid()));

create table if not exists public.asset_ai_enrichment (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  caption text,
  tags text[] not null default '{}',
  objects jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select on public.asset_ai_enrichment to authenticated;
grant all on public.asset_ai_enrichment to service_role;
alter table public.asset_ai_enrichment enable row level security;
create policy asset_ai_enrichment_owner on public.asset_ai_enrichment
  for select to authenticated
  using (exists (select 1 from public.assets a where a.id = asset_id and a.user_id = auth.uid()));

create table if not exists public.asset_search_index (
  asset_id uuid primary key references public.assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  document text not null default '',
  captured_at timestamptz,
  tsv tsvector generated always as (to_tsvector('simple', coalesce(document,''))) stored,
  updated_at timestamptz not null default now()
);
create index if not exists idx_search_index_tsv on public.asset_search_index using gin(tsv);
create index if not exists idx_search_index_user on public.asset_search_index(user_id, captured_at desc);
grant select on public.asset_search_index to authenticated;
grant all on public.asset_search_index to service_role;
alter table public.asset_search_index enable row level security;
create policy asset_search_index_owner on public.asset_search_index
  for select to authenticated using (user_id = auth.uid());

create table if not exists public.asset_dedup_groups (
  id uuid primary key default gen_random_uuid(),
  phash text not null unique,
  canonical_asset_id uuid references public.assets(id) on delete set null,
  member_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select on public.asset_dedup_groups to authenticated;
grant all on public.asset_dedup_groups to service_role;
alter table public.asset_dedup_groups enable row level security;

alter table public.assets add column if not exists dedup_group_id uuid references public.asset_dedup_groups(id) on delete set null;

create table if not exists public.places_summary (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  place_id text not null,
  asset_count int not null default 0,
  updated_at timestamptz not null default now(),
  unique(user_id, place_id)
);
grant select on public.places_summary to authenticated;
grant all on public.places_summary to service_role;
alter table public.places_summary enable row level security;
create policy places_summary_owner on public.places_summary
  for select to authenticated using (user_id = auth.uid());

create table if not exists public.data_exports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending',
  storage_bucket text,
  storage_path text,
  bytes bigint,
  requested_at timestamptz not null default now(),
  ready_at timestamptz,
  error text
);
grant select, insert on public.data_exports to authenticated;
grant all on public.data_exports to service_role;
alter table public.data_exports enable row level security;
create policy data_exports_owner on public.data_exports
  for select to authenticated using (user_id = auth.uid());

alter table public.user_profiles
  add column if not exists deleted_at timestamptz,
  add column if not exists status text not null default 'active',
  add column if not exists ai_processing_enabled boolean not null default true;

alter table public.family_invitations
  add column if not exists last_sent_at timestamptz,
  add column if not exists email_message_id text;

create or replace function public.refresh_timeline_windows(_user_id uuid, _from timestamptz, _to timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  return;
end;
$$;
grant execute on function public.refresh_timeline_windows(uuid, timestamptz, timestamptz) to service_role;
