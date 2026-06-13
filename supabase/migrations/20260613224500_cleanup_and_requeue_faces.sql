-- Remove stale person links for bad-quality faces and force a clean recluster.

CREATE OR REPLACE FUNCTION get_qualifying_faces(
  p_user_id  uuid,
  p_asset_id uuid DEFAULT NULL
)
RETURNS TABLE(asset_id uuid, face_id text, face jsonb)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT
    af.asset_id,
    af.face->>'FaceId'         AS face_id,
    af.face - 'FaceCrop'::text AS face
  FROM public.asset_faces af
  WHERE af.user_id = p_user_id
    AND af.face IS NOT NULL
    AND af.face->>'FaceId' IS NOT NULL
    AND COALESCE((af.face->>'Confidence')::numeric, 0) >= 90
    AND COALESCE(abs((af.face->'FaceDetail'->'Pose'->>'Yaw')::numeric), 999) <= 30
    AND COALESCE(abs((af.face->'FaceDetail'->'Pose'->>'Pitch')::numeric), 999) <= 25
    AND COALESCE((af.face->'FaceDetail'->'Quality'->>'Sharpness')::numeric, 0) >= 35
    AND COALESCE((af.face->'FaceDetail'->'Quality'->>'Brightness')::numeric, 0) >= 25
    AND COALESCE((af.face->'FaceDetail'->'FaceOccluded'->>'Value')::boolean, true) = false
    AND (p_asset_id IS NULL OR af.asset_id = p_asset_id);
$$;

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
