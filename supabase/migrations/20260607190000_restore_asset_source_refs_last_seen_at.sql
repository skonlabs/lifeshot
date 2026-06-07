-- Restore last_seen_at on asset_source_refs (still written by syncSource).
alter table public.asset_source_refs
  add column if not exists last_seen_at timestamptz default now();

update public.asset_source_refs
  set last_seen_at = coalesce(last_seen_at, source_last_seen_at, now())
  where last_seen_at is null;

notify pgrst, 'reload schema';
