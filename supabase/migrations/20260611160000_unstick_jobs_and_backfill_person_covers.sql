-- 1) Backfill people.cover_asset_id / cover_bbox from people.faces jsonb
--    so existing clustered people render on the People page (which filters
--    out rows whose cover resolves to null).
update public.people p
   set cover_asset_id = best.asset_id,
       cover_bbox     = best.bbox
  from (
    select pp.id as person_id,
           (face->>'asset_id')::uuid as asset_id,
           face->'bbox' as bbox,
           (face->>'confidence')::float8 as confidence
      from public.people pp,
           lateral jsonb_array_elements(coalesce(pp.faces, '[]'::jsonb)) face
     where face ? 'bbox'
       and face ? 'asset_id'
  ) best
 where best.person_id = p.id
   and (p.cover_asset_id is null or p.cover_bbox is null)
   and best.confidence = (
     select max((f2->>'confidence')::float8)
       from jsonb_array_elements(coalesce(p.faces, '[]'::jsonb)) f2
      where f2 ? 'bbox' and f2 ? 'asset_id'
   );

-- 2) Unpark normalizeMetadata jobs the old fail_job parked 24h in the future.
update public.job_queue
   set next_attempt_at = now(), updated_at = now()
 where status = 'pending'
   and job_name = 'normalizeMetadata'
   and next_attempt_at > now() + interval '1 hour';

-- 3) Revive dead-lettered enrichAI rows so the worker re-attempts them now
--    that Rekognition credentials are wired correctly.
update public.job_queue
   set status = 'pending',
       dead_letter = false,
       attempts = 0,
       locked_at = null, locked_by = null, finished_at = null,
       next_attempt_at = now(),
       last_error = null,
       updated_at = now()
 where dead_letter = true
   and job_name = 'enrichAI'
   and last_error ilike '%not found: asset%';
