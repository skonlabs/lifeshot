-- ============================================================================
-- Reliable pg_cron -> worker drain.
--
-- Background: a previous migration replaced the hardcoded worker URL with a
-- system_config-based lookup. system_config is only populated on the FIRST
-- successful sync request, so before that pg_cron silently no-ops every tick
-- and queued jobs sit in `pending` forever. That's the "Discovering files..."
-- forever bug.
--
-- Fix: hardcode the worker URL + secret directly in the function, drop the
-- system_config fallback so the schedule works the moment the database is up.
-- ============================================================================

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

-- Re-pin the drain cadence to every 15 seconds. The worker /drain endpoint
-- now has a 50s budget so it can absorb a full Dropbox page (~20s) and still
-- have time to start the next job within the same tick.
do $$
begin
  perform cron.unschedule(jobname) from cron.job
   where jobname in ('lifeshot_drain');
exception when others then null;
end$$;

select cron.schedule(
  'lifeshot_drain',
  '*/15 * * * * *',
  $$select public._cron_call_worker('/drain')$$
);

-- Sanity: an index that makes claim_pending_jobs efficient even at 500K+
-- queued rows. The base index in 0017 covers (lane, priority, next_attempt_at)
-- filtered to pending/non-dead; this one covers the unfiltered status scan.
create index if not exists idx_job_queue_status_next
  on public.job_queue (status, next_attempt_at);
