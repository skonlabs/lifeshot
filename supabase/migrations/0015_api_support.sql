-- 0015_api_support.sql -- API support tables: idempotency, rate limits, job queue, oauth state

create table public.api_idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  route text not null,
  key text not null,
  request_hash text not null,
  response jsonb not null,
  status int not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  unique(user_id, route, key)
);
comment on table public.api_idempotency_keys is 'Stored responses keyed by Idempotency-Key for unsafe POSTs.';
create index idx_idem_expires on public.api_idempotency_keys(expires_at);

create table public.api_rate_limits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket text not null,
  window_start timestamptz not null,
  count int not null default 0,
  updated_at timestamptz not null default now(),
  unique(user_id, bucket, window_start)
);
comment on table public.api_rate_limits is 'Per-user, per-bucket token-bucket counters (sliding window).';
create index idx_rl_user_bucket on public.api_rate_limits(user_id, bucket, window_start desc);

create table public.api_cache_entries (
  id uuid primary key default gen_random_uuid(),
  cache_key text not null unique,
  user_id uuid references auth.users(id) on delete cascade,
  payload jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
comment on table public.api_cache_entries is 'Server-side response cache (Redis substitute).';
create index idx_cache_expires on public.api_cache_entries(expires_at);
create index idx_cache_user on public.api_cache_entries(user_id);

create table public.api_oauth_states (
  id uuid primary key default gen_random_uuid(),
  state text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_id uuid not null references public.source_providers(id) on delete cascade,
  redirect_uri text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes')
);
comment on table public.api_oauth_states is 'CSRF state for source OAuth connect flow.';
create index idx_oauth_state_expires on public.api_oauth_states(expires_at);

create table public.job_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  job_name text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  priority int not null default 5,
  idempotency_key text,
  attempts int not null default 0,
  scheduled_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, job_name, idempotency_key)
);
comment on table public.job_queue is 'Mock job queue (real orchestrator wired later).';
create index idx_jobs_pending on public.job_queue(status, scheduled_at) where status = 'pending';
create index idx_jobs_user on public.job_queue(user_id, created_at desc);
create trigger trg_jobs_updated before update on public.job_queue for each row execute function public.set_updated_at();

-- RLS + grants
alter table public.api_idempotency_keys enable row level security;
alter table public.api_rate_limits enable row level security;
alter table public.api_cache_entries enable row level security;
alter table public.api_oauth_states enable row level security;
alter table public.job_queue enable row level security;

grant select, insert, update, delete on public.api_idempotency_keys to authenticated;
grant all on public.api_idempotency_keys to service_role;
grant all on public.api_rate_limits to service_role;
grant all on public.api_cache_entries to service_role;
grant all on public.api_oauth_states to service_role;
grant select on public.job_queue to authenticated;
grant all on public.job_queue to service_role;

-- Owner can read their own jobs
create policy jobs_owner_select on public.job_queue for select to authenticated
  using (user_id = auth.uid());
-- Idempotency: owner reads its own keys
create policy idem_owner_all on public.api_idempotency_keys for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Helper RPC: token-bucket rate limit (sliding 60s window)
create or replace function public.check_rate_limit(_bucket text, _limit int, _window_seconds int default 60)
returns boolean language plpgsql security definer set search_path = public as $$
declare _uid uuid := auth.uid(); _now timestamptz := now(); _start timestamptz; _cnt int;
begin
  if _uid is null then return false; end if;
  _start := date_trunc('minute', _now);
  insert into public.api_rate_limits(user_id, bucket, window_start, count)
    values (_uid, _bucket, _start, 1)
  on conflict (user_id, bucket, window_start) do update
    set count = api_rate_limits.count + 1, updated_at = now()
  returning count into _cnt;
  delete from public.api_rate_limits where window_start < _now - (_window_seconds || ' seconds')::interval;
  return _cnt <= _limit;
end;
$$;

-- Helper RPC: get/set cache
create or replace function public.cache_get(_key text)
returns jsonb language sql stable security definer set search_path = public as $$
  select payload from public.api_cache_entries
   where cache_key = _key and expires_at > now()
     and (user_id is null or user_id = auth.uid())
   limit 1;
$$;

create or replace function public.cache_set(_key text, _payload jsonb, _ttl_seconds int default 60)
returns void language sql security definer set search_path = public as $$
  insert into public.api_cache_entries(cache_key, user_id, payload, expires_at)
    values (_key, auth.uid(), _payload, now() + (_ttl_seconds || ' seconds')::interval)
  on conflict (cache_key) do update
    set payload = excluded.payload, expires_at = excluded.expires_at, user_id = excluded.user_id;
$$;

create or replace function public.cache_invalidate_user(_prefix text default '')
returns void language sql security definer set search_path = public as $$
  delete from public.api_cache_entries
   where user_id = auth.uid()
     and (_prefix = '' or cache_key like _prefix || '%');
$$;

-- Helper RPC: enqueue job
create or replace function public.enqueue_job(_name text, _payload jsonb, _idem_key text default null, _priority int default 5)
returns uuid language plpgsql security definer set search_path = public as $$
declare _id uuid;
begin
  insert into public.job_queue(user_id, job_name, payload, idempotency_key, priority)
    values (auth.uid(), _name, _payload, _idem_key, _priority)
  on conflict (user_id, job_name, idempotency_key) do update
    set updated_at = now()
  returning id into _id;
  return _id;
end;
$$;
