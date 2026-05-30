-- 0009_observability.sql -- Ingestion events, audit logs, activity, perf

create table public.ingestion_events (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid not null references public.source_accounts(id) on delete cascade,
  phase text not null,
  count int not null default 0,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
comment on table public.ingestion_events is 'Granular ingestion progress events.';
create index idx_ingestion_events_account on public.ingestion_events(source_account_id, occurred_at desc);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  target_type text,
  target_id uuid,
  meta jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
comment on table public.audit_logs is 'Append-only audit trail (no update/delete policy).';
create index idx_audit_user on public.audit_logs(user_id, occurred_at desc);
create index idx_audit_target on public.audit_logs(target_type, target_id);

create table public.user_activity_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_name text not null,
  props jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
comment on table public.user_activity_events is 'Product analytics events.';
create index idx_activity_user on public.user_activity_events(user_id, occurred_at desc);

create table public.performance_metrics (
  id uuid primary key default gen_random_uuid(),
  metric text not null,
  value numeric not null,
  tags jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
comment on table public.performance_metrics is 'Server-side performance counters.';
create index idx_perf_metric on public.performance_metrics(metric, occurred_at desc);
