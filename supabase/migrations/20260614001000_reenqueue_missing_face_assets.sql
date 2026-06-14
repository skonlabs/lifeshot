-- Re-enqueue enrichAI for assets that have no rows in asset_faces at all.
-- These assets were skipped because analyzeAssetFaces previously deleted all
-- detected faces that failed the quality gate before storing them, meaning
-- faces with closed eyes / occlusion were permanently lost from the collection.
-- The fix (removing the quality gate from analyzeAssetFaces) now stores ALL
-- detected faces; this migration re-processes assets that have none stored.

INSERT INTO public.job_queue (
  user_id, job_name, payload, status, priority, lane,
  next_attempt_at, idempotency_key, max_attempts
)
SELECT DISTINCT
  a.user_id,
  'enrichAI',
  jsonb_build_object('asset_id', a.id),
  'pending',
  5,
  'ai',
  now(),
  'enrich-missing-faces:' || a.id,
  5
FROM public.assets a
WHERE a.deleted_state = 'active'
  AND a.user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.asset_faces af WHERE af.asset_id = a.id
  )
ON CONFLICT (user_id, job_name, idempotency_key) DO NOTHING;
