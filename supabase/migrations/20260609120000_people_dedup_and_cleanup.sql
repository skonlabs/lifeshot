-- =====================================================================
-- People dedup, face cleanup, and UNIQUE(user_id, auto_label) on people.
--
-- Rationale:
--   1. clusterPeople upserts with onConflict: "user_id,auto_label" but the
--      base schema never created that unique constraint, so PostgREST has
--      silently inserted duplicate rows. We must add the index, but first
--      merge any pre-existing duplicates so CREATE UNIQUE INDEX succeeds.
--   2. people.faces accumulated entries that fail the front-facing /
--      quality gate, and across runs picked up duplicate
--      (asset_id, rekognition_face_id) entries. Clean both using the same
--      thresholds the runtime now enforces (_ai/face-quality.ts).
--
-- Idempotent: safe to re-run.
-- =====================================================================

begin;

-- Step 1: merge duplicate (user_id, auto_label) rows on `people`.
with dups as (
  select user_id, auto_label, min(id) as keep_id,
         array_agg(id order by created_at nulls last, id) as all_ids
  from public.people
  where auto_label is not null
  group by user_id, auto_label
  having count(*) > 1
),
merge_payload as (
  select
    d.keep_id,
    coalesce(jsonb_agg(f.elem) filter (where f.elem is not null), '[]'::jsonb) as merged_faces,
    coalesce(array_remove(array_agg(distinct rfid), null), array[]::text[]) as merged_face_ids
  from dups d
  join public.people p on p.id = any(d.all_ids)
  left join lateral jsonb_array_elements(coalesce(p.faces, '[]'::jsonb)) as f(elem) on true
  left join lateral unnest(coalesce(p.rekognition_face_ids, array[]::text[])) as rfid on true
  group by d.keep_id
)
update public.people p
set faces = mp.merged_faces,
    rekognition_face_ids = mp.merged_face_ids,
    face_count = jsonb_array_length(mp.merged_faces)
from merge_payload mp
where p.id = mp.keep_id;

delete from public.people p
using (
  select unnest(all_ids) as id, keep_id
  from (
    select min(id) as keep_id, array_agg(id) as all_ids
    from public.people
    where auto_label is not null
    group by user_id, auto_label
    having count(*) > 1
  ) s
) d
where p.id = d.id and p.id <> d.keep_id;

-- Step 2: clean `people.faces` — quality filter + dedup.
with face_rows as (
  select
    p.id as person_id,
    f.elem,
    coalesce((f.elem->>'confidence')::float, (f.elem->>'score')::float, 0.5) as conf,
    f.elem->>'asset_id' as asset_id,
    f.elem->>'rekognition_face_id' as rek_id,
    nullif(f.elem->'rekognition_response'->'Pose'->>'Yaw','')::float as yaw,
    nullif(f.elem->'rekognition_response'->'Pose'->>'Pitch','')::float as pitch,
    nullif(f.elem->'rekognition_response'->'Quality'->>'Sharpness','')::float as sharp,
    nullif(f.elem->'rekognition_response'->'Quality'->>'Brightness','')::float as bright
  from public.people p,
       lateral jsonb_array_elements(coalesce(p.faces, '[]'::jsonb)) as f(elem)
),
kept as (
  select * from face_rows
  where (conf = 0 or conf >= 0.6)
    and (yaw is null or abs(yaw) <= 30)
    and (pitch is null or abs(pitch) <= 25)
    and (sharp is null or sharp >= 35)
    and (bright is null or bright >= 25)
),
deduped as (
  select distinct on (person_id, asset_id, coalesce(rek_id, elem->>'bbox'))
    person_id, elem, rek_id
  from kept
  order by person_id, asset_id, coalesce(rek_id, elem->>'bbox'), conf desc
),
agg as (
  select person_id,
         coalesce(jsonb_agg(elem), '[]'::jsonb) as new_faces,
         coalesce(array_remove(array_agg(distinct rek_id), null), array[]::text[]) as new_face_ids
  from deduped
  group by person_id
)
update public.people p
set faces = coalesce(a.new_faces, '[]'::jsonb),
    face_count = coalesce(jsonb_array_length(a.new_faces), 0),
    rekognition_face_ids = coalesce(a.new_face_ids, array[]::text[])
from agg a
where p.id = a.person_id;

-- People with zero kept faces → reset arrays.
update public.people p
set faces = '[]'::jsonb,
    face_count = 0,
    rekognition_face_ids = array[]::text[]
where p.id not in (
  select distinct p2.id
  from public.people p2,
       lateral jsonb_array_elements(coalesce(p2.faces, '[]'::jsonb)) as f(elem)
);

-- Recompute cover.
with covers as (
  select distinct on (p.id)
    p.id as person_id,
    (f.elem->>'asset_id')::uuid as cover_asset_id,
    f.elem->'bbox' as cover_bbox
  from public.people p,
       lateral jsonb_array_elements(coalesce(p.faces, '[]'::jsonb)) as f(elem)
  order by p.id, coalesce((f.elem->>'confidence')::float, (f.elem->>'score')::float, 0) desc
)
update public.people p
set cover_asset_id = c.cover_asset_id,
    cover_bbox = c.cover_bbox
from covers c
where p.id = c.person_id;

-- Delete auto-labelled empty people. Manually-labelled rows preserved.
delete from public.people
where face_count = 0
  and auto_label is not null
  and (display_name is null or display_name like 'Person %');

-- Step 3: enforce UNIQUE(user_id, auto_label).
create unique index if not exists people_user_auto_label_uidx
  on public.people (user_id, auto_label)
  where auto_label is not null;

commit;
