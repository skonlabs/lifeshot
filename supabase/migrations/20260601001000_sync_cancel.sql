-- Track when a user requested to stop a running sync. The worker checks this
-- at the start of each chained page-run and exits early when set.
alter table public.source_accounts
  add column if not exists sync_cancel_requested_at timestamptz;
