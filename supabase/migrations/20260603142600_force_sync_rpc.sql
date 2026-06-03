-- SECURITY DEFINER RPC so users can force-sync their own source accounts
-- without needing a service-role key in the application server.

create or replace function public.force_sync_source(_account_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  _uid uuid := auth.uid();
  _owner uuid;
  _job_id uuid := gen_random_uuid();
  _now timestamptz := now();
begin
  if _uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select user_id into _owner from public.source_accounts where id = _account_id;

  if _owner is null then
    raise exception 'source_account_not_found' using errcode = 'P0002';
  end if;

  if _owner <> _uid then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  delete from public.source_sync_cursors where source_account_id = _account_id;

  insert into public.job_queue(
    id, user_id, job_name, payload, status, priority, lane,
    next_attempt_at, scheduled_at, idempotency_key, max_attempts
  ) values (
    _job_id, _uid, 'syncSource',
    jsonb_build_object('source_account_id', _account_id, 'mode', 'initial', 'force', true),
    'pending', 5, 'user', _now, _now,
    'force-sync:' || _account_id::text || ':' || _job_id::text, 5
  );

  insert into public.source_sync_jobs(id, source_account_id, kind, status, stats)
  values (
    _job_id, _account_id, 'initial', 'pending',
    jsonb_build_object('stage', 'queued', 'discovered', 1, 'indexed', 0, 'force', true)
  )
  on conflict (id) do update set status = excluded.status, stats = excluded.stats;

  begin
    update public.source_accounts
       set status = 'pending', sync_cancel_requested_at = null
     where id = _account_id;
  exception when undefined_column then
    update public.source_accounts set status = 'pending' where id = _account_id;
  end;

  update public.source_errors
     set resolved = true
   where source_account_id = _account_id and resolved = false;

  return _job_id;
end;
$$;

revoke all on function public.force_sync_source(uuid) from public;
grant execute on function public.force_sync_source(uuid) to authenticated;
