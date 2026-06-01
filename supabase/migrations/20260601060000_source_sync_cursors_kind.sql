-- 20260601060000_source_sync_cursors_kind.sql
-- The new syncSource code stores one cursor row per (source_account_id, kind)
-- (e.g. "list" vs "delta") so that initial and incremental syncs don't clobber
-- each other. The original schema had a single-row-per-account unique constraint.
--
-- Migration strategy:
--   1. Add the kind column (default "list" so existing rows keep working).
--   2. Add last_sync_at column used by saveCursor.
--   3. Drop the old single-column unique constraint.
--   4. Add the new composite unique constraint.

alter table public.source_sync_cursors
  add column if not exists kind text not null default 'list',
  add column if not exists last_sync_at timestamptz;

-- Change the unique constraint from (source_account_id) to (source_account_id, kind).
-- The old constraint was added inline in the CREATE TABLE, so we must drop by name.
do $$
begin
  -- Try the name Postgres typically auto-generates for a named UNIQUE column.
  if exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name   = 'source_sync_cursors'
      and constraint_type = 'UNIQUE'
      and constraint_name = 'source_sync_cursors_source_account_id_key'
  ) then
    alter table public.source_sync_cursors
      drop constraint source_sync_cursors_source_account_id_key;
  end if;
end $$;

alter table public.source_sync_cursors
  drop constraint if exists source_sync_cursors_source_account_id_kind_key;

alter table public.source_sync_cursors
  add constraint source_sync_cursors_source_account_id_kind_key
  unique (source_account_id, kind);
