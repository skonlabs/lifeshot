begin;

-- Remove occluded faces from people.faces (rekognition_response->FaceOccluded.Value = true)
-- and from asset_ai_enrichment.faces (attributes->FaceOccluded.Value = true).
-- After cleaning, reset face_scanned_at on all affected assets so the pipeline
-- re-indexes them with the new occlusion filter and stores them correctly.

-- Step 1: Remove occluded face entries from people.faces.
-- Each element in people.faces stores the Rekognition FaceDetail under
-- the key "rekognition_response". We keep faces where FaceOccluded is absent
-- or explicitly false; reject where Value = 'true'.
with cleaned as (
  select
    p.id as person_id,
    jsonb_agg(f.elem) filter (
      where coalesce(
        (f.elem->'rekognition_response'->'FaceOccluded'->>'Value')::boolean,
        false
      ) = false
    ) as new_faces,
    array_agg(f.elem->>'rekognition_face_id') filter (
      where coalesce(
        (f.elem->'rekognition_response'->'FaceOccluded'->>'Value')::boolean,
        false
      ) = false
        and f.elem->>'rekognition_face_id' is not null
    ) as new_face_ids,
    count(*) filter (
      where coalesce(
        (f.elem->'rekognition_response'->'FaceOccluded'->>'Value')::boolean,
        false
      ) = true
    ) as removed_count
  from public.people p,
       lateral jsonb_array_elements(coalesce(p.faces, '[]'::jsonb)) as f(elem)
  group by p.id
)
update public.people p
set
  faces              = coalesce(c.new_faces, '[]'::jsonb),
  face_count         = coalesce(jsonb_array_length(c.new_faces), 0),
  rekognition_face_ids = coalesce(
    array_remove(c.new_face_ids, null),
    array[]::text[]
  )
from cleaned c
where p.id = c.person_id
  and c.removed_count > 0;

-- Step 2: Remove people rows that are now empty (no valid faces left).
delete from public.people
where face_count = 0
  and auto_label is not null
  and (display_name is null or display_name like 'Person %');

-- Step 3: Remove occluded faces from asset_ai_enrichment.faces.
-- Each element stores the Rekognition FaceDetail under the key "attributes".
with cleaned_ai as (
  select
    e.asset_id,
    jsonb_agg(f.elem) filter (
      where coalesce(
        (f.elem->'attributes'->'FaceOccluded'->>'Value')::boolean,
        false
      ) = false
    ) as new_faces,
    count(*) filter (
      where coalesce(
        (f.elem->'attributes'->'FaceOccluded'->>'Value')::boolean,
        false
      ) = true
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

-- Step 4: Reset face_scanned_at on ALL assets so the pipeline re-scans them
-- with the new occlusion filter. This ensures every photo gets re-indexed
-- and occluded faces are never stored.
update public.assets
set face_scanned_at = null
where face_scanned_at is not null;

-- Step 5: Recompute cover images for people whose cover face may have been removed.
with covers as (
  select distinct on (p.id)
    p.id as person_id,
    (f.elem->>'asset_id')::uuid as cover_asset_id,
    f.elem->'bbox' as cover_bbox
  from public.people p,
       lateral jsonb_array_elements(coalesce(p.faces, '[]'::jsonb)) as f(elem)
  where jsonb_array_length(coalesce(p.faces, '[]'::jsonb)) > 0
  order by p.id,
    coalesce((f.elem->>'confidence')::float, (f.elem->>'score')::float, 0) desc
)
update public.people p
set cover_asset_id = c.cover_asset_id,
    cover_bbox = c.cover_bbox
from covers c
where p.id = c.person_id;

commit;

-- Verification: show counts after migration.
select
  (select count(*) from public.people) as people_total,
  (select sum(face_count) from public.people) as total_faces,
  (select count(*) from public.assets where face_scanned_at is null) as assets_pending_rescan;
