-- Re-enqueue enrichAI for every asset whose face_count is NULL in
-- asset_ai_enrichment. NULL (as opposed to 0) means the Rekognition face
-- detection block never ran — either Rekognition was unconfigured when the
-- job completed, or the job ran before face detection was wired up.
-- Assets with face_count=0 already had Rekognition run and genuinely found
-- no faces, so they are intentionally excluded.
INSERT INTO public.job_queue (job_name, user_id, payload, idempotency_key, status, priority)
SELECT
  'enrichAI',
  a.user_id,
  jsonb_build_object('asset_id', a.id),
  'reenrich-null-faces:' || a.id,
  'pending',
  5
FROM public.assets a
JOIN public.asset_ai_enrichment e ON e.asset_id = a.id
WHERE e.face_count IS NULL
  AND (a.media_type IS NULL OR a.media_type <> 'video')
  AND (a.mime_type IS NULL OR a.mime_type NOT LIKE 'video/%')
ON CONFLICT (idempotency_key) DO NOTHING;
