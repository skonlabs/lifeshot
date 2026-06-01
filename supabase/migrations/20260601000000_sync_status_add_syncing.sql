-- Add 'syncing' to sync_status enum so the worker can mark accounts as
-- actively syncing while a job runs.
alter type sync_status add value if not exists 'syncing';
