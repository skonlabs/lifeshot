create or replace function public.can_access_asset(_asset_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.assets a
    where a.id = _asset_id
      and a.deleted_state = 'active'
      and (
        a.user_id = auth.uid()
        or (a.family_id is not null and public.is_family_member(a.family_id))
      )
  );
$$;
