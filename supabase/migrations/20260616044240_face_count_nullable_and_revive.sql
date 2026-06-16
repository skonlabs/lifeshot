-- Face-count semantics + recovery from worker-killed enrichAI jobs.
--
-- Background:
--   enrichAI's first action is a bootstrap upsert into asset_ai_enrichment.
--   The face_count column defaulted to NOT NULL 0, so a row that was created
--   but whose handler was killed mid-job (Edge Function CPU/wall-time limit)
--   looked identical to "scanned, no faces found". We want:
--     NULL  -> not yet scanned
--     0     -> scanned, Rekognition returned zero faces
--     N>0   -> scanned, N faces stored

-- 1. Make face_count nullable and drop the misleading default.
alter table public.asset_ai_enrichment
  alter column face_count drop not null,
  alter column face_count drop default;

-- 2. Repair bootstrap-only rows: face_count=0 with no scan timestamp on the
--    asset means the handler never completed. Reset to NULL so the next
--    enrichAI run treats it as unscanned.
update public.asset_ai_enrichment e
   set face_count = null
  from public.assets a
 where e.asset_id = a.id
   and e.face_count = 0
   and a.face_scanned_at is null
   and a.media_type in ('photo','live_photo','animation');

-- 3. Revive dead-lettered enrichAI jobs so the worker re-processes them with
--    the new soft-deadline logic in place.
update public.job_queue
   set status          = 'pending',
       dead_letter     = false,
       attempts        = 0,
       locked_at       = null,
       locked_by       = null,
       finished_at     = null,
       last_error      = null,
       next_attempt_at = now(),
       updated_at      = now()
 where job_name = 'enrichAI'
   and dead_letter = true;

-- 4. Diagnostic counts.
select
  (select count(*) from public.asset_ai_enrichment where face_count is null) as unscanned_rows,
  (select count(*) from public.asset_ai_enrichment where face_count = 0)     as zero_face_rows,
  (select count(*) from public.asset_ai_enrichment where face_count > 0)     as with_faces_rows,
  (select count(*) from public.job_queue
    where job_name = 'enrichAI' and status = 'pending' and dead_letter = false) as enrichai_pending;
