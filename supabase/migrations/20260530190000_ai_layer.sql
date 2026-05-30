-- AI layer: cost accounting + caches + sensitive flags.

create table if not exists public.ai_usage_log (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete set null,
  model text not null,
  kind text not null,                 -- 'embed' | 'vision' | 'chat'
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  total_tokens int generated always as (prompt_tokens + completion_tokens) stored,
  estimated_cost_usd numeric(12,6) not null default 0,
  latency_ms int,
  cache_hit boolean not null default false,
  consent_skipped boolean not null default false,
  skip_reason text,
  asset_id uuid,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
grant select on public.ai_usage_log to authenticated;
grant all on public.ai_usage_log to service_role;
alter table public.ai_usage_log enable row level security;
drop policy if exists ai_usage_owner on public.ai_usage_log;
create policy ai_usage_owner on public.ai_usage_log
  for select to authenticated using (user_id = auth.uid());
create index if not exists idx_ai_usage_user_day
  on public.ai_usage_log(user_id, created_at desc);
create index if not exists idx_ai_usage_model on public.ai_usage_log(model);

create table if not exists public.ai_embedding_cache (
  cache_key text primary key,
  model text not null,
  dim int not null,
  embedding jsonb not null,
  created_at timestamptz not null default now()
);
grant all on public.ai_embedding_cache to service_role;

create table if not exists public.ai_vision_cache (
  cache_key text primary key,
  asset_id uuid references public.assets(id) on delete cascade,
  model text not null,
  prompt_version text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
grant all on public.ai_vision_cache to service_role;
create index if not exists idx_vision_cache_asset on public.ai_vision_cache(asset_id);

create table if not exists public.asset_sensitive_flags (
  asset_id uuid primary key references public.assets(id) on delete cascade,
  flags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select on public.asset_sensitive_flags to authenticated;
grant all on public.asset_sensitive_flags to service_role;
alter table public.asset_sensitive_flags enable row level security;
drop policy if exists asset_sensitive_owner on public.asset_sensitive_flags;
create policy asset_sensitive_owner on public.asset_sensitive_flags
  for select to authenticated
  using (exists (select 1 from public.assets a where a.id = asset_id and a.user_id = auth.uid()));

create or replace function public.ai_user_cost_today(_user_id uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(estimated_cost_usd), 0)::numeric
  from public.ai_usage_log
  where user_id = _user_id and created_at >= date_trunc('day', now());
$$;

create or replace function public.ai_user_cost_month(_user_id uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(estimated_cost_usd), 0)::numeric
  from public.ai_usage_log
  where user_id = _user_id and created_at >= date_trunc('month', now());
$$;
