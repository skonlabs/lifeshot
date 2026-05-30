-- 0014_seed_providers.sql -- Seed source_providers with honest capability flags

insert into public.source_providers (kind, name, priority, default_capabilities) values
('google_photos','Google Photos','P0', jsonb_build_object(
  'api','library','can_list',true,'can_thumbnail',true,'can_cache_thumbnail',false,
  'can_cache_preview',false,'video',true,'rate_limited',true,'notes','Caching policy limits storage of originals/derivatives.')),
('icloud','iCloud Photos','High-risk', jsonb_build_object(
  'api','none','can_list',false,'can_thumbnail',false,'video',true,
  'notes','No public cloud photos API; requires user export or on-device agent.')),
('local_ios','iOS Camera Roll','P0', jsonb_build_object(
  'api','photoskit','can_list',true,'can_thumbnail',true,'video',true,'on_device',true)),
('local_android','Android Gallery','P0', jsonb_build_object(
  'api','mediastore','can_list',true,'can_thumbnail',true,'video',true,'on_device',true)),
('desktop_folder','Desktop Folder','P1', jsonb_build_object(
  'api','agent','can_list',true,'can_thumbnail',true,'video',true,'on_device',true)),
('export_import','Export/Import (zip)','P1', jsonb_build_object(
  'api','upload','can_list',true,'can_thumbnail',true,'video',true,'export_only',true)),
('dropbox','Dropbox','P1', jsonb_build_object(
  'api','dropbox-v2','can_list',true,'can_thumbnail',true,'can_cache_thumbnail',true,'video',true)),
('onedrive','OneDrive','P1', jsonb_build_object(
  'api','graph','can_list',true,'can_thumbnail',true,'can_cache_thumbnail',true,'video',true)),
('nas','Network Attached Storage','P2', jsonb_build_object(
  'api','smb','can_list',true,'can_thumbnail',true,'video',true,'on_device',true)),
('external_drive','External Drive','P2', jsonb_build_object(
  'api','agent','can_list',true,'can_thumbnail',true,'video',true,'on_device',true)),
('amazon_photos','Amazon Photos','High-risk', jsonb_build_object(
  'api','restricted','can_list',false,'video',true,'notes','API restricted; expect manual export.'))
on conflict (kind) do update set
  name = excluded.name,
  priority = excluded.priority,
  default_capabilities = excluded.default_capabilities;
