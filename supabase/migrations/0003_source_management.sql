-- 0003_source_management.sql -- Source providers, accounts, tokens, sync state

create table public.source_providers (
  id uuid primary key default gen_random_uuid(),
  kind source_kind not null unique,
  name text not null,
  oauth_config jsonb not null default '{}'::jsonb,
  default_capabilities jsonb not null default '{}'::jsonb,
  priority text not null default 'P1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.source_providers is 'Reference catalog of supported source platforms.';
create trigger trg_source_providers_updated before update on public.source_providers for each row execute function public.set_updated_at();

create table public.source_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_id uuid not null references public.source_providers(id) on delete restrict,
  external_account_id text,
  display_label text,
  status sync_status not null default 'pending',
  connected_at timestamptz default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, provider_id, external_account_id)
);
comment on table public.source_accounts is 'A user''s connection to a source (e.g. their Google Photos).';
create index idx_source_accounts_user on public.source_accounts(user_id);
create index idx_source_accounts_status on public.source_accounts(user_id, status);
create trigger trg_source_accounts_updated before update on public.source_accounts for each row execute function public.set_updated_at();

create table public.source_tokens (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid not null unique references public.source_accounts(id) on delete cascade,
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.source_tokens is 'OAuth tokens; readable ONLY by service_role.';
create trigger trg_source_tokens_updated before update on public.source_tokens for each row execute function public.set_updated_at();

create table public.source_permissions (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid not null unique references public.source_accounts(id) on delete cascade,
  can_cache_thumbnail boolean not null default false,
  can_cache_preview boolean not null default false,
  ai_allowed boolean not null default false,
  scopes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.source_permissions is 'Per-source-account capability/consent flags.';
create trigger trg_source_permissions_updated before update on public.source_permissions for each row execute function public.set_updated_at();

create table public.source_capabilities (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid references public.source_accounts(id) on delete cascade,
  provider_id uuid references public.source_providers(id) on delete cascade,
  capability jsonb not null,
  snapshot_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_account_id is not null or provider_id is not null)
);
comment on table public.source_capabilities is 'Capability snapshot captured at connect time.';
create index idx_source_capabilities_account on public.source_capabilities(source_account_id);
create trigger trg_source_capabilities_updated before update on public.source_capabilities for each row execute function public.set_updated_at();

create table public.source_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid not null references public.source_accounts(id) on delete cascade,
  kind text not null check (kind in ('initial','incremental','backfill','verify')),
  status text not null default 'pending',
  started_at timestamptz,
  finished_at timestamptz,
  stats jsonb not null default '{}'::jsonb,
  error_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.source_sync_jobs is 'Ingestion / sync job log per source account.';
create index idx_sync_jobs_account on public.source_sync_jobs(source_account_id, started_at desc);
create trigger trg_sync_jobs_updated before update on public.source_sync_jobs for each row execute function public.set_updated_at();

create table public.source_sync_cursors (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid not null unique references public.source_accounts(id) on delete cascade,
  cursor text,
  delta_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.source_sync_cursors is 'Incremental sync cursor per source account.';
create trigger trg_sync_cursors_updated before update on public.source_sync_cursors for each row execute function public.set_updated_at();

create table public.source_errors (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid not null references public.source_accounts(id) on delete cascade,
  code text not null,
  message text,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  resolved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.source_errors is 'Errors emitted by sync jobs.';
create index idx_source_errors_account on public.source_errors(source_account_id, occurred_at desc);
create trigger trg_source_errors_updated before update on public.source_errors for each row execute function public.set_updated_at();
