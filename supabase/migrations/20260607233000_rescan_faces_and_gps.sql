-- Re-scan faces against the larger preview_url (was using too-small thumbnails)
-- and re-extract GPS with the larger byte window.

-- 1. Clear face_scanned_at on assets where 0 faces were detected, so enrichAI
--    will retry with the preview URL.
UPDATE public.assets a
SET face_scanned_at = NULL
WHERE face_scanned_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.asset_ai_enrichment e
    WHERE e.asset_id = a.id
      AND jsonb_typeof(e.faces) = 'array'
      AND jsonb_array_length(e.faces) > 0
  );

-- 2. Re-enqueue enrichAI for those assets.
INSERT INTO public.job_queue (job_name, payload, idempotency_key, status, user_id, priority)
SELECT 'enrichAI',
       jsonb_build_object('asset_id', a.id),
       'ai:' || a.id || ':rescan-preview-' || extract(epoch from now())::bigint,
       'pending',
       a.user_id,
       5
FROM public.assets a
WHERE a.face_scanned_at IS NULL
  AND a.status NOT IN ('unfetchable', 'deleted')
  AND (a.media_type IN ('photo','image') OR (a.mime_type IS NOT NULL AND a.mime_type LIKE 'image/%'))
ON CONFLICT (idempotency_key) DO NOTHING;

-- 3. Re-enqueue normalizeMetadata for image assets without GPS so the larger
--    byte-window retry runs.
INSERT INTO public.job_queue (job_name, payload, idempotency_key, status, user_id, priority)
SELECT 'normalizeMetadata',
       jsonb_build_object('asset_id', a.id),
       'norm:' || a.id || ':gps-retry-' || extract(epoch from now())::bigint,
       'pending',
       a.user_id,
       5
FROM public.assets a
LEFT JOIN public.asset_gps g ON g.asset_id = a.id
WHERE a.status NOT IN ('unfetchable', 'deleted')
  AND (a.media_type IN ('photo','image') OR (a.mime_type IS NOT NULL AND a.mime_type LIKE 'image/%'))
  AND (g.asset_id IS NULL OR g.gps_latitude IS NULL OR g.gps_longitude IS NULL)
ON CONFLICT (idempotency_key) DO NOTHING;
