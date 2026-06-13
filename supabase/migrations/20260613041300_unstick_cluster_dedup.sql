-- Recover from the enqueuer dedup bug + incomplete /people/reset purge.
--
-- Symptom: people table empty even though asset_faces has thousands of
-- qualifying rows. Root cause: enqueueJob was treating completed job_queue
-- rows (and job_ledger rows) with matching idempotency keys as duplicates,
-- so per-asset clusterPeople enqueues fired by enrichAI after a face
-- pipeline reset were silently no-op'd against rows from previous cycles.
--
-- Code fix: supabase/functions/_pipeline/enqueuer.ts (revive terminal rows
-- in place) and supabase/functions/organization/index.ts (/people/reset
-- now purges job_queue + job_ledger for the face pipeline).
--
-- This migration clears the historical residue so users currently stuck
-- with an empty People page recover without another manual reset.

DELETE FROM public.job_queue
 WHERE job_name IN ('clusterPeople', 'clusterPlaces', 'detectEvents');

DELETE FROM public.job_ledger
 WHERE job_name IN ('clusterPeople', 'clusterPlaces', 'detectEvents');

INSERT INTO public.job_queue (
  user_id, job_name, payload, status, priority, lane,
  next_attempt_at, idempotency_key, max_attempts
)
SELECT DISTINCT
  af.user_id,
  'clusterPeople',
  jsonb_build_object('user_id', af.user_id),
  'pending',
  5,
  'ai_deep',
  NOW(),
  'cluster-unstick-' || extract(epoch from now())::bigint || ':' || af.user_id,
  5
FROM public.asset_faces af
JOIN public.privacy_settings ps
  ON ps.user_id = af.user_id
 AND ps.face_processing_enabled = true
WHERE af.face_id IS NOT NULL
ON CONFLICT (user_id, job_name, idempotency_key) DO NOTHING;
