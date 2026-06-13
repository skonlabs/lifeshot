# LifeShot Query Catalog

All read/write operations the LifeShot app performs against Supabase. SQL is
the canonical form; RPCs are called via `supabase.rpc(name, params)`.

> RLS note: every query below runs as `authenticated`. RLS scopes rows to
> `auth.uid()` and (where applicable) active family members. `service_role`
> is required only for `source_tokens` and admin maintenance.

## AUTH / PROFILE
- Fetch profile + privacy
  ```sql
  select p.*, ps.* from user_profiles p
    left join privacy_settings ps on ps.user_id = p.user_id
   where p.user_id = auth.uid();
  ```
- Upsert profile: `insert ... on conflict (user_id) do update`
- Update privacy: `update privacy_settings set ... where user_id = auth.uid()`

## SOURCES
- List providers: `select * from source_providers order by priority, name`
- Create source_account: `insert into source_accounts(user_id, provider_id, ...) values (auth.uid(), ...)`
- Store token (service_role): `insert into source_tokens(...) values (...)`
- List user sources:
  ```sql
  select sa.*, sp.kind, sp.name from source_accounts sa
    join source_providers sp on sp.id = sa.provider_id
   where sa.user_id = auth.uid();
  ```
- Record sync job/cursor/error: standard inserts
- Disconnect (cascade): `select disconnect_source('<source_account_id>')` — RPC

## CATALOG
- Get asset by id + sources:
  ```sql
  select a.*, jsonb_agg(r) refs from assets a
    left join asset_source_refs r on r.asset_id = a.id
   where a.id = $1 group by a.id;
  ```
- Insert/upsert asset + source_ref:
  ```sql
  insert into assets(user_id, media_type, capture_time, checksum_hash, ...) values (...) returning id;
  insert into asset_source_refs(asset_id, source_account_id, source_asset_id, is_primary)
    values ($1, $2, $3, true)
  on conflict (source_account_id, source_asset_id) do update set source_last_seen_at = now();
  ```
- Viewport: `select * from get_viewport(_cursor, _viewport_size, _filters)` — RPC
- Timeline window: `select * from get_timeline_window(_granularity, _bucket)` — RPC
- Dashboard counts: `select get_dashboard_counts()` — RPC

## SEARCH
- Log search: `insert into search_queries(user_id, raw_query, parsed) values (auth.uid(), $1, $2)`
- Hybrid search: `select * from hybrid_search(_query_text, _query_vector, _filters, _k)` — RPC
- Facets: `select get_facets(_filters)` — RPC
- Cache read/write on `search_result_cache`

## ORGANIZATION
- List events: `select * from events where user_id = auth.uid() order by start_time desc`
- Event detail: events + event_assets + event_people + event_places joined
- List people: `select * from people where user_id = auth.uid() or is_family_member(family_id)`
- List places: similar to people
- List duplicate groups + members:
  ```sql
  select g.*, jsonb_agg(m) members from duplicate_groups g
    join duplicate_group_members m on m.group_id = g.id
   where g.user_id = auth.uid() group by g.id;
  ```
- Confirm primary (no auto-delete):
  ```sql
  update duplicate_groups set recommended_primary_asset_id = $1, status = 'reviewed'
   where id = $2 and user_id = auth.uid();
  ```
- Insert correction: `insert into user_corrections(user_id, target_type, target_id, correction) ...`
- Merge / Split: `select merge_assets($survivor, $merged, $reason)`, `select split_source_ref($ref, $reason)` — RPCs

## PRIVACY / LIFECYCLE
- Write consent: `insert into consent_records(user_id, scope, granted, granted_at, version) ...`
- Delete derived for source: handled inside `disconnect_source(...)`
- Export user data: `select export_user_data()` — RPC (jsonb blob)
- Delete account: `select delete_account()` — RPC

## TIMELINE
- Refresh windows: `select refresh_timeline_windows()` — RPC
- Refresh MV: `refresh materialized view concurrently mv_asset_year_month;` (service_role / cron)
