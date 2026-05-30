-- Configure pg_cron to call the deployed worker edge function
ALTER DATABASE postgres SET app.worker_base_url = 'https://vohevknnbvpaooletyts.supabase.co/functions/v1/worker';
ALTER DATABASE postgres SET app.worker_secret = '80a39ce51e2c586e58f83bcfc86ff6569d9919bc8538b6936d22cc0a4e6440b4';
