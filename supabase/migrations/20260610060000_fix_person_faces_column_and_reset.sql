-- Fix: clusterPeople code was writing "face_id" but the DB column is
-- "rekognition_face_id". Code has been updated; this migration just ensures
-- the column exists (already added by 20260606222238 and 20260607153000 but
-- guard with IF NOT EXISTS for safety).
ALTER TABLE public.person_faces
  ADD COLUMN IF NOT EXISTS rekognition_face_id text;

CREATE INDEX IF NOT EXISTS idx_person_faces_rek_face_id
  ON public.person_faces(rekognition_face_id)
  WHERE rekognition_face_id IS NOT NULL;

-- Full reset: wipe fragmented data so the fixed pipeline rebuilds cleanly.
-- The fixes deployed with this migration:
--   1. person_faces upserts now write to the correct column (rekognition_face_id)
--   2. clusterPeople jobs are coalesced per-user (no more concurrent race)
--   3. face-detector dedup keeps canonical face_id (no more cluster fragmentation)
--   4. Face crop padding increased 10% → 40% (full head chin-to-hairline visible)
--   5. MIN_COVER_SCORE = 0.30 prevents side profiles becoming avatars

DELETE FROM public.person_faces;
DELETE FROM public.people WHERE auto_label IS NOT NULL;

UPDATE public.asset_ai_enrichment
SET faces = '[]'::jsonb
WHERE faces IS NOT NULL AND faces != '[]'::jsonb;

UPDATE public.assets
SET face_scanned_at = NULL
WHERE face_scanned_at IS NOT NULL;

-- Re-enqueue enrichAI for all image assets so the fixed pipeline processes them.
INSERT INTO public.job_queue (job_name, payload, idempotency_key, status, user_id, priority)
SELECT
  'enrichAI',
  jsonb_build_object('asset_id', a.id),
  'ai:' || a.id || ':face-reset-' || extract(epoch from now())::bigint,
  'pending',
  a.user_id,
  5
FROM public.assets a
WHERE a.media_type = 'photo'
  AND a.deleted_state = 'active'
  AND a.face_scanned_at IS NULL
ON CONFLICT (idempotency_key) DO NOTHING;

SELECT
  (SELECT count(*) FROM public.people WHERE auto_label IS NULL)      AS manual_people_preserved,
  (SELECT count(*) FROM public.person_faces)                          AS person_faces_cleared,
  (SELECT count(*) FROM public.assets WHERE face_scanned_at IS NULL) AS assets_queued,
  (SELECT count(*) FROM public.job_queue WHERE job_name = 'enrichAI' AND status = 'pending') AS jobs_enqueued;
