begin;

-- Purge faces exceeding the tightened pose thresholds (yaw > 20°, pitch > 15°)
-- from people.faces using the stored rekognition_response->Pose JSON path.
-- This is a surgical, data-driven cleanup — no full re-scan required.

-- Step 1: Remove non-frontal faces from people.faces.
with cleaned as (
  select
    p.id as person_id,
    jsonb_agg(f.elem order by (f.elem->>'created_at') asc) filter (
      where
        -- Keep face only when BOTH yaw AND pitch are within new thresholds.
        -- Faces with no Pose data are also removed (they pre-date the quality gate).
        (f.elem->'rekognition_response'->'Pose') is not null
        and abs((f.elem->'rekognition_response'->'Pose'->>'Yaw')::float)   <= 20
        and abs((f.elem->'rekognition_response'->'Pose'->>'Pitch')::float) <= 15
        and coalesce((f.elem->'rekognition_response'->'Quality'->>'Sharpness')::float, 100) >= 40
        and coalesce((f.elem->'rekognition_response'->'FaceOccluded'->>'Value')::boolean, false) = false
    ) as new_faces,
    count(*) filter (
      where
        (f.elem->'rekognition_response'->'Pose') is null
        or abs((f.elem->'rekognition_response'->'Pose'->>'Yaw')::float)   > 20
        or abs((f.elem->'rekognition_response'->'Pose'->>'Pitch')::float) > 15
        or coalesce((f.elem->'rekognition_response'->'Quality'->>'Sharpness')::float, 100) < 40
        or coalesce((f.elem->'rekognition_response'->'FaceOccluded'->>'Value')::boolean, false) = true
    ) as removed_count
  from public.people p,
       lateral jsonb_array_elements(coalesce(p.faces, '[]'::jsonb)) as f(elem)
  group by p.id
)
update public.people p
set
  faces      = coalesce(c.new_faces, '[]'::jsonb),
  face_count = coalesce(jsonb_array_length(c.new_faces), 0)
from cleaned c
where p.id = c.person_id
  and c.removed_count > 0;

-- Step 2: Remove auto-labelled people that now have zero valid faces.
delete from public.people
where auto_label is not null
  and face_count = 0;

-- Step 3: Recompute cover_asset_id / cover_bbox to the highest-confidence
-- remaining face for each person.
with covers as (
  select distinct on (p.id)
    p.id                              as person_id,
    (f.elem->>'asset_id')::uuid       as cover_asset_id,
    f.elem->'bbox'                    as cover_bbox
  from public.people p,
       lateral jsonb_array_elements(coalesce(p.faces, '[]'::jsonb)) as f(elem)
  where jsonb_array_length(coalesce(p.faces, '[]'::jsonb)) > 0
  order by p.id,
    coalesce((f.elem->>'confidence')::float, 0) desc
)
update public.people p
set cover_asset_id = c.cover_asset_id,
    cover_bbox     = c.cover_bbox
from covers c
where p.id = c.person_id;

-- Step 4: Also purge asset_ai_enrichment.faces so clusterPeople cannot
-- re-add the same bad faces if it runs again on existing enrichment rows.
with cleaned_ai as (
  select
    e.asset_id,
    jsonb_agg(f.elem) filter (
      where
        (f.elem->'attributes'->'Pose') is not null
        and abs((f.elem->'attributes'->'Pose'->>'Yaw')::float)   <= 20
        and abs((f.elem->'attributes'->'Pose'->>'Pitch')::float) <= 15
        and coalesce((f.elem->'attributes'->'Quality'->>'Sharpness')::float, 100) >= 40
        and coalesce((f.elem->'attributes'->'FaceOccluded'->>'Value')::boolean, false) = false
    ) as new_faces,
    count(*) filter (
      where
        (f.elem->'attributes'->'Pose') is null
        or abs((f.elem->'attributes'->'Pose'->>'Yaw')::float)   > 20
        or abs((f.elem->'attributes'->'Pose'->>'Pitch')::float) > 15
        or coalesce((f.elem->'attributes'->'Quality'->>'Sharpness')::float, 100) < 40
        or coalesce((f.elem->'attributes'->'FaceOccluded'->>'Value')::boolean, false) = true
    ) as removed_count
  from public.asset_ai_enrichment e,
       lateral jsonb_array_elements(coalesce(e.faces, '[]'::jsonb)) as f(elem)
  group by e.asset_id
)
update public.asset_ai_enrichment e
set faces = coalesce(c.new_faces, '[]'::jsonb)
from cleaned_ai c
where e.asset_id = c.asset_id
  and c.removed_count > 0;

-- Step 5: Reset face_scanned_at only on assets whose enrichment faces were
-- fully cleared (so enrichAI re-detects them with the tighter quality gate).
update public.assets a
set face_scanned_at = null
where exists (
  select 1 from public.asset_ai_enrichment e
  where e.asset_id = a.id
    and (e.faces = '[]'::jsonb or e.faces is null)
)
  and a.face_scanned_at is not null;

commit;

select
  (select count(*) from public.people)                                    as people_total,
  (select sum(face_count) from public.people)                             as total_faces,
  (select count(*) from public.assets where face_scanned_at is null)     as assets_pending_rescan;
