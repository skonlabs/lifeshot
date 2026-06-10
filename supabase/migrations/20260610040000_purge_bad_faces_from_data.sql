-- Purge faces that fail quality thresholds based on ACTUAL stored Rekognition values.
-- Thresholds derived from querying the real data:
--   Bad faces: |yaw| 25–77°, |pitch| -29 to -63°, sharpness 5–16, occluded=true
--   Good faces: |yaw| < 20°, |pitch| < 20°, sharpness >= 35
--
-- This migration operates on stored data directly — independent of Edge Function code.

begin;

-- Step 1: Remove bad faces from asset_ai_enrichment.faces.
with cleaned as (
  select
    e.asset_id,
    jsonb_agg(f.elem) filter (
      where
        -- must have Pose data
        (f.elem->'attributes'->'Pose') is not null
        -- yaw within 20°
        and abs((f.elem->'attributes'->'Pose'->>'Yaw')::float) <= 20
        -- pitch within 20°
        and abs((f.elem->'attributes'->'Pose'->>'Pitch')::float) <= 20
        -- sharpness at least 35
        and coalesce((f.elem->'attributes'->'Quality'->>'Sharpness')::float, 100) >= 35
        -- not occluded
        and coalesce((f.elem->'attributes'->'FaceOccluded'->>'Value')::boolean, false) = false
    ) as good_faces,
    count(*) filter (
      where
        (f.elem->'attributes'->'Pose') is null
        or abs((f.elem->'attributes'->'Pose'->>'Yaw')::float)   > 20
        or abs((f.elem->'attributes'->'Pose'->>'Pitch')::float) > 20
        or coalesce((f.elem->'attributes'->'Quality'->>'Sharpness')::float, 100) < 35
        or coalesce((f.elem->'attributes'->'FaceOccluded'->>'Value')::boolean, false) = true
    ) as removed
  from public.asset_ai_enrichment e,
       lateral jsonb_array_elements(coalesce(e.faces, '[]'::jsonb)) as f(elem)
  where jsonb_array_length(coalesce(e.faces, '[]'::jsonb)) > 0
  group by e.asset_id
)
update public.asset_ai_enrichment e
set faces = coalesce(c.good_faces, '[]'::jsonb)
from cleaned c
where e.asset_id = c.asset_id
  and c.removed > 0;

-- Step 2: Delete all auto-clustered people and person_faces — they were built
-- from the bad faces and need to be rebuilt from clean data.
delete from public.person_faces;
delete from public.people where auto_label is not null;

-- Step 3: Reset face_scanned_at on assets whose faces were fully cleared,
-- so the pipeline re-detects them.
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
  (select count(*) from public.asset_ai_enrichment where jsonb_array_length(coalesce(faces,'[]'::jsonb)) > 0) as assets_with_faces,
  (select sum(jsonb_array_length(coalesce(faces,'[]'::jsonb))) from public.asset_ai_enrichment)               as total_faces_remaining,
  (select count(*) from public.assets where face_scanned_at is null)                                          as assets_queued_rescan,
  (select count(*) from public.people)                                                                         as people_remaining;
