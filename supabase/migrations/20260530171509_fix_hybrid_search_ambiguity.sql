-- Fix "column reference asset_id is ambiguous" in hybrid_search by aliasing
-- inner CTE columns so they don't collide with OUT parameter names.
drop function if exists public.hybrid_search(text, vector, jsonb, int);

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
#variable_conflict use_column
declare _uid uuid := auth.uid(); _from timestamptz; _to timestamptz;
begin
  _from := nullif(_filters->>'from','')::timestamptz;
  _to   := nullif(_filters->>'to','')::timestamptz;

  return query
  with fts as (
    select sd.asset_id as a_id,
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
    select a_id, row_number() over (order by rank desc) as rk from fts
  ),
  vec as (
    select * from (
      select m.asset_id as a_id, m.distance, row_number() over (order by m.distance asc) as rk
        from public.match_assets_by_embedding(_query_vector, greatest(_k*4,200), _from, _to) m
       where _query_vector is not null
    ) v
  ),
  union_set as (
    select a_id, 1.0 / (60 + rk) as s from fts_ranked
    union all
    select a_id, 1.0 / (60 + rk) as s from vec
  ),
  fused as (
    select a_id, sum(s) as score from union_set group by a_id
  ),
  dedup as (
    select f.a_id, f.score, a.duplicate_group_id,
           row_number() over (
             partition by coalesce(a.duplicate_group_id::text, f.a_id::text)
             order by f.score desc
           ) rn
      from fused f join public.assets a on a.id = f.a_id
     where a.user_id = _uid and a.deleted_state = 'active'
  )
  select d.a_id as asset_id,
         d.score::numeric as score,
         jsonb_build_object(
           'fts', (select rank from fts where fts.a_id = d.a_id limit 1),
           'vector', (select distance from vec where vec.a_id = d.a_id limit 1),
           'duplicate_group_id', d.duplicate_group_id
         ) as explanation
    from dedup d
   where d.rn = 1
   order by d.score desc
   limit _k;
end;
$$;

grant execute on function public.hybrid_search(text, vector, jsonb, int) to authenticated, service_role;
