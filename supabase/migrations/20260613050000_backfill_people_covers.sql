with picks as (
  select
    p.id,
    (
      select f
      from jsonb_array_elements(p.faces) f
      order by coalesce((f->>'confidence')::numeric, 0) desc
      limit 1
    ) as best
  from public.people p
  where p.cover_asset_id is null
    and jsonb_typeof(p.faces) = 'array'
    and jsonb_array_length(p.faces) > 0
)
update public.people p
set
  cover_asset_id = (picks.best->>'asset_id')::uuid,
  cover_bbox     = picks.best->'bbox'
from picks
where picks.id = p.id;
