-- Remove stale person links for bad-quality faces and force a clean recluster.

UPDATE public.asset_faces
SET person_id = NULL,
    updated_at = now()
WHERE face IS NULL
   OR face->>'FaceId' IS NULL
   OR COALESCE((face->>'Confidence')::numeric, 0) < 90
   OR COALESCE(abs((face->'FaceDetail'->'Pose'->>'Yaw')::numeric), 999) > 30
   OR COALESCE(abs((face->'FaceDetail'->'Pose'->>'Pitch')::numeric), 999) > 25
   OR COALESCE((face->'FaceDetail'->'Quality'->>'Sharpness')::numeric, 0) < 35
   OR COALESCE((face->'FaceDetail'->'Quality'->>'Brightness')::numeric, 0) < 25
   OR COALESCE((face->'FaceDetail'->'FaceOccluded'->>'Value')::boolean, true) = true;

DELETE FROM public.people p
WHERE p.user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.asset_faces af
    WHERE af.person_id = p.id
  );

DELETE FROM public.job_queue
WHERE job_name = 'clusterPeople';

DELETE FROM public.job_ledger
WHERE job_name = 'clusterPeople';

INSERT INTO public.job_queue (user_id, job_name, payload, status, priority, lane, next_attempt_at, idempotency_key, max_attempts)
SELECT DISTINCT
  af.user_id,
  'clusterPeople',
  jsonb_build_object('user_id', af.user_id),
  'pending',
  5,
  'ai',
  now(),
  'people:cleanup:' || af.user_id || ':' || floor(extract(epoch from now()))::text,
  5
FROM public.asset_faces af
WHERE af.user_id IS NOT NULL
ON CONFLICT (user_id, job_name, idempotency_key) DO NOTHING;
