-- Seed OAuth config for Dropbox & OneDrive (client ids/secrets live in edge function secrets, not here)
update public.source_providers
set oauth_config = jsonb_build_object(
  'authorize_url', 'https://www.dropbox.com/oauth2/authorize',
  'token_url',     'https://api.dropboxapi.com/oauth2/token',
  'scope',         'files.metadata.read files.content.read account_info.read',
  'access_type',   'offline',
  'prompt',        'consent'
)
where kind = 'dropbox';

update public.source_providers
set oauth_config = jsonb_build_object(
  'authorize_url', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  'token_url',     'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  'scope',         'offline_access Files.Read User.Read',
  'prompt',        'consent'
)
where kind = 'onedrive';

-- Storage bucket for export_import zip / file uploads. Private; access via signed URLs.
insert into storage.buckets (id, name, public)
values ('source_uploads', 'source_uploads', false)
on conflict (id) do nothing;

drop policy if exists "source_uploads_insert_own" on storage.objects;
create policy "source_uploads_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'source_uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "source_uploads_read_own" on storage.objects;
create policy "source_uploads_read_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'source_uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "source_uploads_delete_own" on storage.objects;
create policy "source_uploads_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'source_uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
