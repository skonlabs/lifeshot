-- 0010_functions_rpc.sql -- RPC: viewport, hybrid_search, dashboard, merge/split,
-- disconnect, delete_account, export, timeline refresh, facets, match_assets.

-- ============ match_assets_by_embedding ============
create or replace function public.match_assets_by_embedding(
  _query vector(1536),
  _k int default 50,
  _filter_from timestamptz default null,
  _filter_to timestamptz default null
) returns table (
  asset_id uuid,
  distance float4,
  capture_time timestamptz
) language sql stable security definer set search_path = public as $$
  select e.asset_id, (e.embedding <=> _query)::float4 as distance, a.capture_time
    from public.asset_embeddings e
    join public.assets a on a.id = e.asset_id
   where a.user_id = auth.uid()
     and a.deleted_state = 'active'
     and (_filter_from is null or a.capture_time >= _filter_from)
     and (_filter_to is null or a.capture_time <= _filter_to)
   order by e.embedding <=> _query
   limit _k;
$$;

-- ============ get_viewport ============
create or replace function public.get_viewport(
  _cursor text default null,
  _viewport_size int default 60,
  _filters jsonb default '{}'::jsonb
) returns table (
  asset_id uuid,
  capture_time timestamptz,
  thumbnail_cache_key text,
  blurhash text,
  dominant_color text,
  width int,
  height int,
  media_type media_type,
  source_badge text,
  hydration_status text,
  next_cursor text
) language plpgsql stable security definer set search_path = public as $$
declare _from timestamptz; _uid uuid := auth.uid();
begin
  if _cursor is not null then _from := _cursor::timestamptz; end if;
  return query
    with page as (
      select a.id, a.capture_time, a.thumbnail_cache_key, a.blurhash, a.dominant_color,
             a.width, a.height, a.media_type,
             (select sp.kind::text from public.asset_source_refs r
                join public.source_accounts sa on sa.id = r.source_account_id
                join public.source_providers sp on sp.id = sa.provider_id
               where r.asset_id = a.id and r.is_primary
               limit 1) as source_badge,
             case when a.thumbnail_cache_key is null then 'pending' else 'ready' end as hydration_status
        from public.assets a
       where a.user_id = _uid
         and a.deleted_state = 'active'
         and (_from is null or a.capture_time < _from)
       order by a.capture_time desc nulls last, a.id desc
       limit _viewport_size
    )
    select p.id, p.capture_time, p.thumbnail_cache_key, coalesce(p.blurhash, ab.blurhash),
           coalesce(p.dominant_color, ab.dominant_color), p.width, p.height, p.media_type,
           p.source_badge, p.hydration_status,
           (select min(capture_time)::text from page) as next_cursor
      from page p
      left join public.asset_blurhashes ab on ab.asset_id = p.id;
end;
$$;

-- ============ get_dashboard_counts ============
create or replace function public.get_dashboard_counts()
returns jsonb language sql stable security definer set search_path = public as $$
  with mine as (
    select * from public.assets where user_id = auth.uid() and deleted_state = 'active'
  )
  select jsonb_build_object(
    'total_assets', (select count(*) from mine),
    'at_risk', (select count(*) from mine where source_count <= 1),
    'duplicate_groups', (select count(*) from public.duplicate_groups where user_id = auth.uid() and status = 'open'),
    'per_year', (
      select coalesce(jsonb_object_agg(yr::text, c), '{}'::jsonb)
        from (select extract(year from capture_time)::int yr, count(*) c
                from mine where capture_time is not null group by 1) s
    ),
    'per_source', (
      select coalesce(jsonb_object_agg(kind, c), '{}'::jsonb)
        from (select sp.kind::text kind, count(distinct a.id) c
                from mine a
                join public.asset_source_refs r on r.asset_id = a.id
                join public.source_accounts sa on sa.id = r.source_account_id
                join public.source_providers sp on sp.id = sa.provider_id
               group by sp.kind) s
    )
  );
$$;

-- ============ hybrid_search ============
create or replace function public.hybrid_search(
  _query_text text,
  _query_vector vector(1536) default null,
  _filters jsonb default '{}'::jsonb,
  _k int default 50
) returns table (
  asset_id uuid,
  score numeric,
  explanation jsonb
) language plpgsql stable security definer set search_path = public as $$
declare _uid uuid := auth.uid(); _from timestamptz; _to timestamptz;
begin
  _from := nullif(_filters->>'from','')::timestamptz;
  _to   := nullif(_filters->>'to','')::timestamptz;

  return query
  with fts as (
    select sd.asset_id,
           ts_rank_cd(sd.search_tsv, plainto_tsquery('english', _query_text)) as rank
      from public.asset_search_documents sd
      join public.assets a on a.id = sd.asset_id
     where sd.user_id = _uid
       and a.deleted_state = 'active'
       and (_query_text is null or sd.search_tsv @@ plainto_tsquery('english', _query_text))
       and (_from is null or a.capture_time >= _from)
       and (_to is null or a.capture_time <= _to)
     order by rank desc
     limit greatest(_k * 4, 200)
  ),
  fts_ranked as (
    select asset_id, row_number() over (order by rank desc) as rk from fts
  ),
  vec as (
    select * from (
      select asset_id, distance, row_number() over (order by distance asc) as rk
        from public.match_assets_by_embedding(_query_vector, greatest(_k*4,200), _from, _to)
       where _query_vector is not null
    ) v
  ),
  union_set as (
    select asset_id, 1.0 / (60 + rk) as s from fts_ranked
    union all
    select asset_id, 1.0 / (60 + rk) as s from vec
  ),
  fused as (
    select asset_id, sum(s) as score from union_set group by asset_id
  ),
  dedup as (
    -- keep highest-score asset per duplicate_group
    select f.asset_id, f.score, a.duplicate_group_id,
           row_number() over (
             partition by coalesce(a.duplicate_group_id::text, f.asset_id::text)
             order by f.score desc
           ) rn
      from fused f join public.assets a on a.id = f.asset_id
     where a.user_id = _uid and a.deleted_state = 'active'
  )
  select d.asset_id, d.score::numeric,
         jsonb_build_object(
           'fts', (select rank from fts where fts.asset_id = d.asset_id limit 1),
           'vector', (select distance from vec where vec.asset_id = d.asset_id limit 1),
           'duplicate_group_id', d.duplicate_group_id
         )
    from dedup d
   where d.rn = 1
   order by d.score desc
   limit _k;
end;
$$;

-- ============ get_facets ============
create or replace function public.get_facets(_filters jsonb default '{}'::jsonb)
returns jsonb language sql stable security definer set search_path = public as $$
  with mine as (
    select * from public.assets where user_id = auth.uid() and deleted_state = 'active'
  )
  select jsonb_build_object(
    'by_year', (
      select coalesce(jsonb_object_agg(yr::text, c), '{}'::jsonb)
        from (select extract(year from capture_time)::int yr, count(*) c
                from mine where capture_time is not null group by 1 order by 1 desc) s),
    'by_country', (
      select coalesce(jsonb_object_agg(coalesce(location_country,'unknown'), c), '{}'::jsonb)
        from (select location_country, count(*) c from mine group by 1) s),
    'by_event', (
      select coalesce(jsonb_object_agg(coalesce(event_id::text,'none'), c), '{}'::jsonb)
        from (select event_id, count(*) c from mine group by 1) s)
  );
$$;

-- ============ merge_assets ============
create or replace function public.merge_assets(_survivor uuid, _merged uuid, _reason text)
returns void language plpgsql security definer set search_path = public as $$
declare _uid uuid := auth.uid();
begin
  if not exists(select 1 from public.assets where id = _survivor and user_id = _uid) or
     not exists(select 1 from public.assets where id = _merged   and user_id = _uid) then
    raise exception 'Not authorized to merge these assets';
  end if;
  update public.asset_source_refs set asset_id = _survivor where asset_id = _merged;
  update public.assets set deleted_state = 'soft_deleted' where id = _merged;
  insert into public.audit_logs(user_id, action, target_type, target_id, meta)
    values (_uid, 'merge_assets', 'asset', _survivor,
            jsonb_build_object('merged', _merged, 'reason', _reason));
  -- Record lineage edge in graph
  insert into public.memory_nodes(user_id, node_type, ref_id) values (_uid, 'asset', _survivor)
    on conflict do nothing;
end;
$$;

-- ============ split_source_ref ============
create or replace function public.split_source_ref(_source_ref_id uuid, _reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare _uid uuid := auth.uid(); _old_asset uuid; _new_asset uuid;
begin
  select a.id into _old_asset from public.asset_source_refs r
    join public.assets a on a.id = r.asset_id
   where r.id = _source_ref_id and a.user_id = _uid;
  if _old_asset is null then raise exception 'Not authorized'; end if;
  insert into public.assets(user_id, media_type) values (_uid, 'photo') returning id into _new_asset;
  update public.asset_source_refs set asset_id = _new_asset where id = _source_ref_id;
  insert into public.audit_logs(user_id, action, target_type, target_id, meta)
    values (_uid, 'split_source_ref', 'asset', _new_asset,
            jsonb_build_object('detached_from', _old_asset, 'reason', _reason));
  return _new_asset;
end;
$$;

-- ============ disconnect_source ============
create or replace function public.disconnect_source(_source_account_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare _uid uuid := auth.uid();
begin
  if not exists(select 1 from public.source_accounts where id = _source_account_id and user_id = _uid) then
    raise exception 'Not authorized';
  end if;
  update public.source_accounts
     set status = 'disconnected', disconnected_at = now()
   where id = _source_account_id;
  delete from public.source_tokens where source_account_id = _source_account_id;
  -- Drop derived caches for assets only sourced from this account
  delete from public.asset_source_refs where source_account_id = _source_account_id;
  -- Mark orphaned assets as soft_deleted
  update public.assets a
     set deleted_state = 'soft_deleted'
   where a.user_id = _uid
     and not exists(select 1 from public.asset_source_refs r where r.asset_id = a.id);
  insert into public.audit_logs(user_id, action, target_type, target_id, meta)
    values (_uid, 'disconnect_source', 'source_account', _source_account_id, '{}'::jsonb);
end;
$$;

-- ============ delete_account ============
create or replace function public.delete_account()
returns void language plpgsql security definer set search_path = public as $$
declare _uid uuid := auth.uid();
begin
  if _uid is null then raise exception 'Unauthenticated'; end if;
  insert into public.audit_logs(user_id, action, target_type, target_id, meta)
    values (_uid, 'delete_account_initiated', 'user', _uid, '{}'::jsonb);
  delete from public.assets where user_id = _uid;
  delete from public.source_accounts where user_id = _uid;
  delete from public.user_profiles where user_id = _uid;
  delete from public.privacy_settings where user_id = _uid;
  -- Family memberships removed; families owned solely by this user cascade
  delete from public.family_members where user_id = _uid;
  delete from public.families where owner_user_id = _uid
     and not exists(select 1 from public.family_members fm where fm.family_id = families.id);
  insert into public.audit_logs(user_id, action, target_type, target_id, meta)
    values (_uid, 'delete_account_completed', 'user', _uid, '{}'::jsonb);
end;
$$;

-- ============ export_user_data ============
create or replace function public.export_user_data()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'profile', (select to_jsonb(p) from public.user_profiles p where p.user_id = auth.uid()),
    'privacy', (select to_jsonb(p) from public.privacy_settings p where p.user_id = auth.uid()),
    'assets',   (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb)
                  from public.assets a where a.user_id = auth.uid()),
    'sources',  (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
                  from public.source_accounts s where s.user_id = auth.uid()),
    'consents', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
                  from public.consent_records c where c.user_id = auth.uid())
  );
$$;

-- ============ refresh_timeline_windows ============
create or replace function public.refresh_timeline_windows(_user_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare _uid uuid := coalesce(_user_id, auth.uid());
begin
  if _uid is null then raise exception 'No user'; end if;
  delete from public.timeline_windows where user_id = _uid;

  insert into public.timeline_windows(user_id, granularity, bucket, asset_ids, asset_count, start_time, end_time)
  select _uid, 'month',
         to_char(date_trunc('month', capture_time), 'YYYY-MM'),
         array_agg(id order by capture_time desc),
         count(*),
         min(capture_time), max(capture_time)
    from public.assets
   where user_id = _uid and deleted_state = 'active' and capture_time is not null
   group by 2, 3;

  insert into public.timeline_windows(user_id, granularity, bucket, asset_ids, asset_count, start_time, end_time)
  select _uid, 'year',
         to_char(date_trunc('year', capture_time), 'YYYY'),
         array_agg(id order by capture_time desc),
         count(*),
         min(capture_time), max(capture_time)
    from public.assets
   where user_id = _uid and deleted_state = 'active' and capture_time is not null
   group by 2, 3;
end;
$$;

-- ============ get_timeline_window ============
create or replace function public.get_timeline_window(_granularity text, _bucket text)
returns table (asset_ids uuid[], asset_count int, start_time timestamptz, end_time timestamptz)
language sql stable security definer set search_path = public as $$
  select asset_ids, asset_count, start_time, end_time
    from public.timeline_windows
   where user_id = auth.uid() and granularity = _granularity and bucket = _bucket;
$$;
