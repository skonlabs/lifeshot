-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Drop legacy public.asset_locations table.
--    Search docs already read from asset_gps (see migration 20260601030000);
--    clusterPlaces stopped writing here months ago. Only stale reader was a
--    completeness check in syncSource, removed in the same change.
-- ─────────────────────────────────────────────────────────────────────────────

-- Trigger from 0012_triggers.sql is auto-dropped with the table, but be explicit
-- so the migration is safe even if the trigger was already removed.
drop trigger if exists trg_search_doc_locations on public.asset_locations;
drop table if exists public.asset_locations cascade;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Consolidate duplicate_groups primary pointer.
--    Two columns mean the same thing:
--      - recommended_primary_asset_id  (older, from 0007_organization.sql)
--      - canonical_asset_id            (newer, from 20260601010000_dedup_*)
--    dedupGroup.ts writes canonical_asset_id; the organization PATCH endpoint
--    and the duplicates UI use recommended_primary_asset_id. Backfill into
--    canonical_asset_id and drop the older column.
-- ─────────────────────────────────────────────────────────────────────────────

update public.duplicate_groups
   set canonical_asset_id = coalesce(canonical_asset_id, recommended_primary_asset_id)
 where canonical_asset_id is null
   and recommended_primary_asset_id is not null;

alter table public.duplicate_groups
  drop column if exists recommended_primary_asset_id;
