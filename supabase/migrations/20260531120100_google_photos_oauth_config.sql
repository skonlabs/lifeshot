-- Populate Google Photos OAuth config so the connect endpoint can build a real authorize_url.
-- Note: client_id is intentionally NOT stored here; the callback reads GOOGLE_CLIENT_ID
-- from edge function secrets to keep credentials out of seeded data.
update public.source_providers
set oauth_config = jsonb_build_object(
  'authorize_url', 'https://accounts.google.com/o/oauth2/v2/auth',
  'token_url',     'https://oauth2.googleapis.com/token',
  'scope',         'https://www.googleapis.com/auth/photoslibrary.readonly',
  'access_type',   'offline',
  'prompt',        'consent'
)
where kind = 'google_photos';
