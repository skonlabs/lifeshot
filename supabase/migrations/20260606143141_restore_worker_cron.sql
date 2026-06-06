-- Restore the pg_cron -> worker drain schedule.
-- Symptom: jobs sit forever in `pending` with queue_attempts = 0; sync and
-- "Force Sync" never progress, but POSTing /worker/drain/once manually
-- claims and processes them. The worker is healthy; pg_cron stopped firing.
-- This migration is idempotent.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public._cron_call_worker(_path text, _body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  _url    text := 'https://vohevknnbvpaooletyts.supabase.co/functions/v1/worker';
  _secret text := '80a39ce51e2c586e58f83bcfc86ff6569d9919bc8538b6936d22cc0a4e6440b4';
begin
  return net.http_post(
    url     := _url || _path,
    headers := jsonb_build_object(
      'content-type',    'application/json',
      'x-worker-secret', _secret
    ),
    body    := _body
  );
end;
$$;

do $$
begin
  perform cron.unschedule(jobname)
    from cron.job
   where jobname in ('lifeshot_drain', 'lifeshot_drain_safety');
exception when others then null;
end$$;

-- Primary: 15s cadence (requires pg_cron >= 1.5 seconds syntax).
do $$
begin
  perform cron.schedule(
    'lifeshot_drain',
    '*/15 * * * * *',
    $cron$select public._cron_call_worker('/drain')$cron$
  );
exception when others then
  raise notice 'lifeshot_drain seconds-cadence schedule failed: %', sqlerrm;
end$$;

-- Safety net: standard minute cadence so drain still runs even if the
-- seconds-level schedule is rejected by the installed pg_cron.
select cron.schedule(
  'lifeshot_drain_safety',
  '* * * * *',
  $cron$select public._cron_call_worker('/drain')$cron$
);

-- Kick the worker immediately so any jobs queued before this migration ran
-- get picked up without waiting for the first cron tick.
select public._cron_call_worker('/drain');
