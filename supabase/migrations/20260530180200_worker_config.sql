-- Hardcode worker URL + secret into _cron_call_worker (ALTER DATABASE is forbidden on Supabase).
create or replace function public._cron_call_worker(_path text, _body jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  _url text := 'https://vohevknnbvpaooletyts.supabase.co/functions/v1/worker';
  _secret text := '80a39ce51e2c586e58f83bcfc86ff6569d9919bc8538b6936d22cc0a4e6440b4';
begin
  return net.http_post(
    url := _url || _path,
    headers := jsonb_build_object('content-type','application/json','x-worker-secret', _secret),
    body := _body
  );
end;
$$;
