-- ============================================================================
-- Persistent worker config so pg_cron's drain actually fires.
--
-- Previously _cron_call_worker() read app.worker_base_url / app.worker_secret
-- from session GUCs that are never set on this project, so the pg_cron
-- 'lifeshot_drain' job silently no-ops every 10s. When a syncSource chain
-- breaks (Edge runtime kill mid-await), nothing retries the orphaned job.
--
-- Fix: store worker URL + secret in a table that edge functions populate on
-- startup. _cron_call_worker falls back to that table when GUC is unset.
-- ============================================================================

create table if not exists public.system_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
grant select, insert, update on public.system_config to service_role;
alter table public.system_config enable row level security;

create or replace function public._cron_call_worker(_path text, _body jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  _url text := nullif(current_setting('app.worker_base_url', true), '');
  _secret text := nullif(current_setting('app.worker_secret', true), '');
  _service_key text;
begin
  if _url is null then
    select value into _url from public.system_config where key = 'worker_base_url';
  end if;
  if _secret is null then
    select value into _secret from public.system_config where key = 'worker_secret';
  end if;
  select value into _service_key from public.system_config where key = 'service_role_key';

  if _url is null or _url = '' then return null; end if;
  return net.http_post(
    url := _url || _path,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-worker-secret', coalesce(_secret, ''),
      'authorization', 'Bearer ' || coalesce(_service_key, '')
    ),
    body := _body
  );
end;
$$;
