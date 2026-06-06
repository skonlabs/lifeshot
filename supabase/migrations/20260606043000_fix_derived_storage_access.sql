insert into storage.buckets (id, name, public)
values ('lifeshot-derived', 'lifeshot-derived', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('lifeshot-exports', 'lifeshot-exports', false)
on conflict (id) do nothing;

drop policy if exists "lifeshot_derived_read_own" on storage.objects;
create policy "lifeshot_derived_read_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'lifeshot-derived'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "lifeshot_exports_read_own" on storage.objects;
create policy "lifeshot_exports_read_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'lifeshot-exports'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
