-- 0013_materialized_views.sql -- MV: per-user year/month rollup for fast facets
-- Refresh by calling: refresh materialized view concurrently mv_asset_year_month;

create materialized view if not exists public.mv_asset_year_month as
select user_id,
       extract(year from capture_time)::int as yr,
       extract(month from capture_time)::int as mo,
       count(*) as asset_count,
       min(capture_time) as start_time,
       max(capture_time) as end_time
  from public.assets
 where deleted_state = 'active' and capture_time is not null
 group by 1,2,3;

create unique index if not exists idx_mv_asset_year_month_pk
  on public.mv_asset_year_month(user_id, yr, mo);
