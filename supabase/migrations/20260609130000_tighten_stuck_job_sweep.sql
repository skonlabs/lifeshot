-- Tighten stuck-job sweep so a crashed worker (e.g. Edge
-- WORKER_RESOURCE_LIMIT) does not leave a sync stalled for up to 15
-- minutes. Runs every minute and reclaims any job whose lock is older
-- than 120s; worker /drain also self-heals on each invocation.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'lifeshot_stuck_sweep') then
    perform cron.unschedule('lifeshot_stuck_sweep');
  end if;
  perform cron.schedule(
    'lifeshot_stuck_sweep',
    '* * * * *',
    $cron$select public.sweep_stuck_jobs(120);$cron$
  );
end$$;
