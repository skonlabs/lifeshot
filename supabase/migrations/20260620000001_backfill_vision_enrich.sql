-- Enqueue enrichAI (vision pass) for all assets that are face-scanned but lack a caption.
-- Uses per-asset idempotency key to prevent duplicate jobs.
INSERT INTO public.job_queue (user_id, job_name, payload, idempotency_key, status, priority)
SELECT
  a.user_id,
  'enrichAI',
  jsonb_build_object('asset_id', a.id),
  'vision-backfill:' || a.id,
  'pending',
  5
FROM assets a
JOIN asset_ai_enrichment aie ON aie.asset_id = a.id
WHERE a.deleted_state = 'active'
  AND aie.face_count IS NOT NULL
  AND (aie.caption IS NULL OR aie.caption = '')
ON CONFLICT (idempotency_key) DO NOTHING;
