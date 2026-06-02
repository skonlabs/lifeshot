-- Aggregate per-account asset counts by media_type in SQL, so the API does
-- not have to round-trip thousands of asset ids through a PostgREST IN(...).
create or replace function public.account_media_counts(_account_ids uuid[])
returns table(source_account_id uuid, media_type text, count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select r.source_account_id,
         coalesce(a.media_type, 'unknown') as media_type,
         count(*)::bigint as count
  from public.asset_source_refs r
  left join public.assets a on a.id = r.asset_id
  where r.source_account_id = any(_account_ids)
  group by r.source_account_id, coalesce(a.media_type, 'unknown');
$$;

grant execute on function public.account_media_counts(uuid[]) to authenticated, service_role;
