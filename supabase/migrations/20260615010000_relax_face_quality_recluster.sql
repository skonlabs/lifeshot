-- Re-enqueue clusterPeople for every user that has face processing enabled and
-- has asset_faces rows. The quality gate in face-quality.ts was too strict:
-- it treated absent EyesOpen/FaceOccluded fields as failures and used Yaw ≤30°
-- / Sharpness ≥35 which excluded many real frontal faces. Thresholds are now
-- relaxed and absent fields pass, so re-clustering will pick up previously
-- excluded faces and add them to the people table.
WITH users_with_faces AS (
  SELECT DISTINCT af.user_id
  FROM public.asset_faces af
  JOIN public.privacy_settings ps ON ps.user_id = af.user_id
  WHERE ps.face_processing_enabled = true
)
INSERT INTO public.job_queue (job_name, user_id, payload, idempotency_key, status, priority)
SELECT
  'clusterPeople',
  u.user_id,
  jsonb_build_object('user_id', u.user_id),
  'recluster-quality-relax:' || u.user_id,
  'pending',
  5
FROM users_with_faces u
ON CONFLICT (user_id, job_name, idempotency_key) DO NOTHING;
