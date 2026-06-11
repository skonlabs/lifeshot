create or replace function public.fail_job(_id uuid, _error text, _backoff_seconds integer)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare _j public.job_queue%rowtype;
begin
  select * into _j from public.job_queue where id = _id for update;
  if not found then return; end if;
  if _j.attempts >= _j.max_attempts then
    update public.job_queue set
      status = 'failed', dead_letter = true, last_error = _error,
      finished_at = now(), updated_at = now() where id = _id;
  else
    update public.job_queue set
      status = 'pending', last_error = _error, locked_at = null, locked_by = null,
      next_attempt_at = now() + (_backoff_seconds || ' seconds')::interval,
      updated_at = now() where id = _id;
  end if;
end;
$function$;

create or replace function public.sweep_stuck_jobs(_stale_seconds integer default 600)
 returns integer language plpgsql security definer set search_path to 'public'
as $function$
declare _n int;
begin
  -- jobs out of retries: dead-letter them instead of resurrecting forever
  update public.job_queue
     set status = 'failed', dead_letter = true,
         last_error = coalesce(last_error, 'worker crashed (resource limit?)'),
         locked_at = null, locked_by = null,
         finished_at = now(), updated_at = now()
   where status = 'running'
     and locked_at < now() - (_stale_seconds || ' seconds')::interval
     and attempts >= max_attempts;
  -- jobs with retries left: back off proportionally instead of immediate retry
  update public.job_queue
     set status = 'pending', locked_at = null, locked_by = null,
         next_attempt_at = now() + (least(attempts, 10) * interval '30 seconds'),
         updated_at = now()
   where status = 'running'
     and locked_at < now() - (_stale_seconds || ' seconds')::interval;
  get diagnostics _n = row_count;
  return _n;
end;
$function$;

-- one-time cleanup: dead-letter every zombie that already blew past its retry budget
update public.job_queue
   set status = 'failed', dead_letter = true,
       last_error = coalesce(last_error, 'zombie: exceeded max_attempts'),
       locked_at = null, locked_by = null, finished_at = now(), updated_at = now()
 where status in ('running','pending') and attempts >= max_attempts;
