-- 20260601010000_dedup_and_events_schema.sql
-- Adds columns needed by the updated dedupGroup and detectEvents jobs.

-- ── duplicate_groups: add signal, canonical_asset_id, member_count ──────────
alter table public.duplicate_groups
  add column if not exists signal text,           -- 'sha256' | 'phash' | 'embedding'
  add column if not exists signal_value text,     -- the actual hash / cluster id
  add column if not exists canonical_asset_id uuid references public.assets(id) on delete set null,
  add column if not exists member_count int not null default 0;

-- Unique index so dedupGroup can upsert without creating duplicates.
create unique index if not exists idx_dup_groups_signal
  on public.duplicate_groups(user_id, signal, signal_value)
  where signal is not null and signal_value is not null;

-- ── duplicate_group_members: add is_canonical flag ───────────────────────────
alter table public.duplicate_group_members
  add column if not exists is_canonical boolean not null default false;

-- ── events: add asset_count + unique constraint for upsert idempotency ───────
alter table public.events
  add column if not exists asset_count int not null default 0;

-- Unique on (user_id, start_time) so detectEvents can upsert on re-runs.
-- Using a partial unique index to avoid conflicts with family events (null user_id).
create unique index if not exists idx_events_user_start_time
  on public.events(user_id, start_time)
  where user_id is not null;
