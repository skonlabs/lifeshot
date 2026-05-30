-- ============================================================================
-- 0017_worker_layer.sql — pg_cron + job_queue based background pipeline.
-- ============================================================================

-- ---- job_queue extensions -------------------------------------------------
alter table public.job_queue
  add column if not exists lane text not null default 'default',
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists last_error text,
  add column if not exists max_attempts int not null default 5,
  add column if not exists dead_letter boolean not null default false,
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by text;

create index if not exists idx_jobs_drain
  on public.job_queue (lane, priority desc, next_attempt_at)
  where status = 'pending' and dead_letter = false;
create index if not exists idx_jobs_locked on public.job_queue(locked_at)
  where status = 'running';

-- ---- ledger: job results keyed by idempotency_key --------------------------
create table if not exists public.job_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  job_name text not null,
  idempotency_key text not null,
  result jsonb not null default '{}'::jsonb,
  status text not null default 'completed',
  recorded_at timestamptz not null default now(),
  unique(job_name, idempotency_key)
);
grant all on public.job_ledger to service_role;
alter table public.job_ledger enable row level security;

-- ---- sync cursors per source account/kind ----------------------------------
create table if not exists public.source_sync_cursors (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid not null references public.source_accounts(id) on delete cascade,
  kind text not null,                       -- 'list' | 'delta'
  cursor jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(source_account_id, kind)
);
grant all on public.source_sync_cursors to service_role;
alter table public.source_sync_cursors enable row level security;

-- ---- per-source token bucket -----------------------------------------------
create table if not exists public.source_rate_buckets (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid not null references public.source_accounts(id) on delete cascade,
  window_start timestamptz not null,
  count int not null default 0,
  updated_at timestamptz not null default now(),
  unique(source_account_id, window_start)
);
grant all on public.source_rate_buckets to service_role;
alter table public.source_rate_buckets enable row level security;
create index if not exists idx_rate_buckets_window
  on public.source_rate_buckets(source_account_id, window_start desc);

-- ---- ingest uploads (export-import + local-device payload registry) --------
create table if not exists public.ingest_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_account_id uuid references public.source_accounts(id) on delete cascade,
  kind text not null,                       -- 'export_zip' | 'device_batch'
  storage_bucket text not null,
  storage_path text not null,
  payload jsonb not null default '{}'::jsonb,
  bytes bigint,
  status text not null default 'pending',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert on public.ingest_uploads to authenticated;
grant all on public.ingest_uploads to service_role;
alter table public.ingest_uploads enable row level security;
create policy ingest_uploads_owner on public.ingest_uploads
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- dead-letter (long-term store; job_queue.dead_letter is the flag) ------
create table if not exists public.dead_letter_jobs (
  id uuid primary key default gen_random_uuid(),
  original_job_id uuid,
  user_id uuid,
  job_name text not null,
  payload jsonb not null,
  attempts int not null,
  last_error text,
  failed_at timestamptz not null default now(),
  replayed_at timestamptz
);
grant all on public.dead_letter_jobs to service_role;
alter table public.dead_letter_jobs enable row level security;

-- ============================================================================
-- pg_net + pg_cron wiring (worker drain + cron jobs).
-- ============================================================================
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Atomic claim of N pending jobs (highest priority first).
create or replace function public.claim_pending_jobs(_limit int, _worker_id text, _lanes text[] default null)
returns setof public.job_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select id from public.job_queue
     where status = 'pending'
       and dead_letter = false
       and next_attempt_at <= now()
       and (_lanes is null or lane = any(_lanes))
     order by priority desc, next_attempt_at
     for update skip locked
     limit _limit
  )
  update public.job_queue j
     set status = 'running',
         locked_at = now(),
         locked_by = _worker_id,
         attempts = j.attempts + 1,
         started_at = coalesce(j.started_at, now()),
         updated_at = now()
    from candidate c
   where j.id = c.id
  returning j.*;
end;
$$;
grant execute on function public.claim_pending_jobs(int, text, text[]) to service_role;

-- Release a job back to pending with backoff or mark dead-letter.
create or replace function public.fail_job(_id uuid, _error text, _backoff_seconds int)
returns void language plpgsql security definer set search_path = public as $$
declare _j public.job_queue%rowtype;
begin
  select * into _j from public.job_queue where id = _id for update;
  if not found then return; end if;
  if _j.attempts >= _j.max_attempts then
    update public.job_queue set
      status = 'failed', dead_letter = true, last_error = _error,
      finished_at = now(), updated_at = now() where id = _id;
    insert into public.dead_letter_jobs(original_job_id, user_id, job_name, payload, attempts, last_error)
      values (_j.id, _j.user_id, _j.job_name, _j.payload, _j.attempts, _error);
  else
    update public.job_queue set
      status = 'pending', last_error = _error, locked_at = null, locked_by = null,
      next_attempt_at = now() + (_backoff_seconds || ' seconds')::interval,
      updated_at = now() where id = _id;
  end if;
end;
$$;
grant execute on function public.fail_job(uuid, text, int) to service_role;

create or replace function public.complete_job(_id uuid, _result jsonb)
returns void language sql security definer set search_path = public as $$
  update public.job_queue
     set status = 'completed', finished_at = now(),
         result = coalesce(_result,'{}'::jsonb),
         updated_at = now(), locked_at = null, locked_by = null
   where id = _id;
$$;
grant execute on function public.complete_job(uuid, jsonb) to service_role;

-- Sweep stuck running jobs (worker died mid-run).
create or replace function public.sweep_stuck_jobs(_stale_seconds int default 600)
returns int language plpgsql security definer set search_path = public as $$
declare _n int;
begin
  update public.job_queue
     set status = 'pending', locked_at = null, locked_by = null,
         next_attempt_at = now(), updated_at = now()
   where status = 'running'
     and locked_at < now() - (_stale_seconds || ' seconds')::interval;
  get diagnostics _n = row_count;
  return _n;
end;
$$;
grant execute on function public.sweep_stuck_jobs(int) to service_role;

-- Per-source token-bucket check (used by syncSource for provider rate limits).
create or replace function public.source_take_token(_source_account_id uuid, _per_min int)
returns boolean language plpgsql security definer set search_path = public as $$
declare _now timestamptz := now(); _start timestamptz := date_trunc('minute', _now); _cnt int;
begin
  insert into public.source_rate_buckets(source_account_id, window_start, count)
    values (_source_account_id, _start, 1)
  on conflict (source_account_id, window_start) do update
    set count = source_rate_buckets.count + 1, updated_at = now()
  returning count into _cnt;
  delete from public.source_rate_buckets
   where source_account_id = _source_account_id
     and window_start < _now - interval '5 minutes';
  return _cnt <= _per_min;
end;
$$;
grant execute on function public.source_take_token(uuid, int) to service_role;

-- ============================================================================
-- pg_cron schedules: invoke /worker drain + periodic maintenance.
-- The worker URL + secret are stored in app settings, set out-of-band.
-- ============================================================================
create or replace function public._cron_call_worker(_path text, _body jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare _url text := current_setting('app.worker_base_url', true);
        _secret text := current_setting('app.worker_secret', true);
begin
  if _url is null or _url = '' then return null; end if;
  return net.http_post(
    url := _url || _path,
    headers := jsonb_build_object('content-type','application/json','x-worker-secret', coalesce(_secret,'')),
    body := _body
  );
end;
$$;

-- Drain every 10s; incremental sync every 15m; stuck sweep every 5m.
do $$
begin
  perform cron.unschedule(jobname) from cron.job where jobname in
    ('lifeshot_drain','lifeshot_incremental_sync','lifeshot_stuck_sweep','lifeshot_dead_letter_sweep');
exception when others then null;
end$$;

select cron.schedule('lifeshot_drain',           '*/10 * * * * *', $$select public._cron_call_worker('/drain')$$);
select cron.schedule('lifeshot_incremental_sync','*/15 * * * *',   $$select public._cron_call_worker('/cron/incremental-sync')$$);
select cron.schedule('lifeshot_stuck_sweep',     '*/5 * * * *',    $$select public.sweep_stuck_jobs(600)$$);
select cron.schedule('lifeshot_dead_letter_sweep','0 */6 * * *',   $$select public._cron_call_worker('/cron/dead-letter-sweep')$$);
