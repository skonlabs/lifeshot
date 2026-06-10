-- ─────────────────────────────────────────────────────────────────────────────
-- Consolidate all location data into public.asset_gps (canonical store) and
-- drop the legacy flat columns on public.assets.
--
-- Removed columns (assets):
--   - location_lat, location_lng       → asset_gps.gps_latitude / gps_longitude
--   - location_city, location_country  → asset_gps.reverse_geocoded_city /
--                                         reverse_geocoded_country
--
-- Code writers/readers updated in the same change:
--   syncSource, normalizeMetadata, _metadata/persistence, clusterPlaces.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Backfill: insert an asset_gps row for any asset that has coords on the
--    flat columns but no asset_gps row yet.
insert into public.asset_gps (
  asset_id, user_id, gps_latitude, gps_longitude,
  reverse_geocoded_city, reverse_geocoded_country,
  location_source, location_confidence
)
select
  a.id, a.user_id, a.location_lat, a.location_lng,
  a.location_city, a.location_country,
  'legacy_assets_column', 0.8
from public.assets a
left join public.asset_gps g on g.asset_id = a.id
where g.asset_id is null
  and a.location_lat is not null
  and a.location_lng is not null;

-- 2) Backfill: copy reverse-geocoded names from assets onto existing
--    asset_gps rows where they are missing.
update public.asset_gps g
   set reverse_geocoded_city    = coalesce(g.reverse_geocoded_city,    a.location_city),
       reverse_geocoded_country = coalesce(g.reverse_geocoded_country, a.location_country)
  from public.assets a
 where a.id = g.asset_id
   and (
     (g.reverse_geocoded_city    is null and a.location_city    is not null) or
     (g.reverse_geocoded_country is null and a.location_country is not null)
   );

-- 3) Rewrite get_facets RPC so by_country reads from asset_gps.
create or replace function public.get_facets(_filters jsonb default '{}'::jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  with mine as (
    select id, capture_time, event_id, user_id
      from public.assets
     where user_id = auth.uid() and deleted_state = 'active'
  )
  select jsonb_build_object(
    'by_year', (
      select coalesce(jsonb_object_agg(yr::text, c), '{}'::jsonb)
        from (select extract(year from capture_time)::int yr, count(*) c
                from mine where capture_time is not null group by 1 order by 1 desc) s),
    'by_country', (
      select coalesce(jsonb_object_agg(coalesce(country,'unknown'), c), '{}'::jsonb)
        from (
          select coalesce(g.reverse_geocoded_country, 'unknown') as country, count(*) c
            from mine m
            left join public.asset_gps g on g.asset_id = m.id
           group by 1
        ) s),
    'by_event', (
      select coalesce(jsonb_object_agg(coalesce(event_id::text,'none'), c), '{}'::jsonb)
        from (select event_id, count(*) c from mine group by 1) s)
  );
$$;

-- 4) Drop the legacy columns.
alter table public.assets
  drop column if exists location_lat,
  drop column if exists location_lng,
  drop column if exists location_city,
  drop column if exists location_country;
