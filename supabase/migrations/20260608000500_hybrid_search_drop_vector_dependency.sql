-- Search currently writes and queries assets.search_content / assets.search_tsv.
-- The legacy asset_embeddings table was removed by 20260606090000_db_cleanup.sql,
-- but hybrid_search still referenced match_assets_by_embedding(), which in turn
-- referenced the dropped table. That made every search crash in production.
--
-- For the current schema, degrade hybrid_search to FTS-only scoring.

create or replace function public.hybrid_search(
  _query_text text,
  _query_vector vector default null,
  _filters jsonb default '{}'::jsonb,
  _k integer default 50
) returns table(
  asset_id uuid,
  score numeric,
  explanation jsonb
)
language plpgsql
stable
security definer
set search_path to public
as $func$
#variable_conflict use_column
declare
  _uid uuid := auth.uid();
  _from timestamptz;
  _to timestamptz;
  _media_type text;
begin
  _from := nullif(_filters->>'from', '')::timestamptz;
  _to := nullif(_filters->>'to', '')::timestamptz;
  _media_type := nullif(_filters->>'media_type', '');

  return query
  with fts as (
    select
      a.id as a_id,
      ts_rank_cd(a.search_tsv, plainto_tsquery('english', _query_text)) as rank
    from public.assets a
    where a.user_id = _uid
      and a.deleted_state = 'active'
      and (_query_text is null or a.search_tsv @@ plainto_tsquery('english', _query_text))
      and (_from is null or a.capture_time >= _from)
      and (_to is null or a.capture_time <= _to)
      and (_media_type is null or a.media_type::text = _media_type)
      and (
        _filters->'sources' is null
        or _filters->>'sources' = 'null'
        or exists (
          select 1
          from public.asset_source_refs asr
          where asr.asset_id = a.id
            and asr.source_kind = any(array(select jsonb_array_elements_text(_filters->'sources')))
        )
      )
  ),
  ranked as (
    select
      fts.a_id,
      fts.rank,
      row_number() over (order by fts.rank desc, fts.a_id) as rk
    from fts
  ),
  dedup as (
    select
      r.a_id,
      (1.0 / (60 + r.rk))::numeric as score,
      a.duplicate_group_id,
      r.rank,
      row_number() over (
        partition by coalesce(a.duplicate_group_id::text, r.a_id::text)
        order by r.rank desc, r.a_id
      ) as rn
    from ranked r
    join public.assets a on a.id = r.a_id
    where a.user_id = _uid
      and a.deleted_state = 'active'
      and (_media_type is null or a.media_type::text = _media_type)
  )
  select
    d.a_id as asset_id,
    d.score,
    jsonb_build_object(
      'fts', d.rank,
      'vector', null,
      'duplicate_group_id', d.duplicate_group_id
    ) as explanation
  from dedup d
  where d.rn = 1
  order by d.score desc, d.a_id
  limit _k;
end
$func$;

grant execute on function public.hybrid_search(text, vector, jsonb, int) to authenticated, service_role;
