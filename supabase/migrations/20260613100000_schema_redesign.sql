-- Schema redesign: simplify people, asset_faces, asset_ai_enrichment tables.
--
-- people           → id, user_id, asset_id, display_name, face (jsonb), created_at, updated_at
-- asset_faces      → id, asset_id, user_id, face (jsonb), created_at, updated_at
-- asset_ai_enrichment → id, asset_id, user_id, caption, tags (jsonb), faces (jsonb), face_count, created_at, updated_at

-- ── people ────────────────────────────────────────────────────────────────────
ALTER TABLE public.people
  DROP COLUMN IF EXISTS is_child,
  DROP COLUMN IF EXISTS is_elder,
  DROP COLUMN IF EXISTS consent_required,
  DROP COLUMN IF EXISTS auto_label,
  DROP COLUMN IF EXISTS faces,
  DROP COLUMN IF EXISTS face_count,
  DROP COLUMN IF EXISTS rekognition_face_ids,
  DROP COLUMN IF EXISTS cover_face_crop,
  DROP COLUMN IF EXISTS cover_asset_id,
  DROP COLUMN IF EXISTS cover_bbox;

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES public.assets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS face jsonb;

DROP INDEX IF EXISTS idx_people_user_auto_label;
DROP INDEX IF EXISTS idx_people_rekog_face_ids;

-- ── asset_faces ───────────────────────────────────────────────────────────────
ALTER TABLE public.asset_faces
  DROP COLUMN IF EXISTS face_id,
  DROP COLUMN IF EXISTS bbox,
  DROP COLUMN IF EXISTS confidence,
  DROP COLUMN IF EXISTS face_crop,
  DROP COLUMN IF EXISTS attributes;

ALTER TABLE public.asset_faces
  ADD COLUMN IF NOT EXISTS face jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DROP INDEX IF EXISTS idx_asset_faces_face_id;
DROP INDEX IF EXISTS idx_asset_faces_asset_face;

-- ── asset_ai_enrichment ───────────────────────────────────────────────────────
ALTER TABLE public.asset_ai_enrichment
  DROP COLUMN IF EXISTS objects,
  DROP COLUMN IF EXISTS enriched_at,
  DROP COLUMN IF EXISTS rekognition_response;

-- Convert tags from text[] to jsonb (preserves existing tag arrays as JSON arrays).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'asset_ai_enrichment'
      AND column_name  = 'tags'
      AND data_type    = 'ARRAY'
  ) THEN
    ALTER TABLE public.asset_ai_enrichment
      ALTER COLUMN tags TYPE jsonb USING to_jsonb(tags);
  END IF;
END $$;

-- Default existing NULL faces to empty array.
ALTER TABLE public.asset_ai_enrichment
  ALTER COLUMN faces SET DEFAULT '[]'::jsonb;

ALTER TABLE public.asset_ai_enrichment
  ADD COLUMN IF NOT EXISTS face_count integer NOT NULL DEFAULT 0;

-- ── get_qualifying_faces RPC (updated for new face jsonb schema) ──────────────
DROP FUNCTION IF EXISTS get_qualifying_faces(uuid, uuid);

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
  WHERE af.user_id  = p_user_id
    AND af.face IS NOT NULL
    AND af.face->>'FaceId' IS NOT NULL
    AND (af.face->'FaceDetail'->'FaceOccluded'->>'Value') = 'false'
    AND (af.face->>'Confidence')::numeric                          >  90
    AND abs((af.face->'FaceDetail'->'Pose'->>'Yaw')::numeric)   <  40
    AND abs((af.face->'FaceDetail'->'Pose'->>'Pitch')::numeric) <  35
    AND (p_asset_id IS NULL OR af.asset_id = p_asset_id);
$$;

GRANT EXECUTE ON FUNCTION get_qualifying_faces(uuid, uuid) TO service_role;

-- ── Purge all legacy data so the pipeline re-runs with clean state ────────────
DELETE FROM public.people WHERE user_id IS NOT NULL;

DELETE FROM public.asset_faces WHERE user_id IS NOT NULL;

UPDATE public.asset_ai_enrichment
  SET faces = '[]'::jsonb, face_count = 0
  WHERE user_id IS NOT NULL;

UPDATE public.assets
  SET face_scanned_at = NULL
  WHERE face_scanned_at IS NOT NULL;

-- Clear all face-pipeline jobs and ledger entries so everything re-queues.
DELETE FROM public.job_queue
  WHERE job_name IN ('enrichAI', 'clusterPeople');

DELETE FROM public.job_ledger
  WHERE job_name IN ('enrichAI', 'clusterPeople');

-- Enqueue enrichAI for all image assets.
INSERT INTO public.job_queue (user_id, job_name, payload, status, priority, lane, next_attempt_at, idempotency_key, max_attempts)
SELECT
  a.user_id,
  'enrichAI',
  jsonb_build_object('asset_id', a.id),
  'pending',
  5,
  'ai',
  NOW(),
  'schema-redesign:ai:' || a.id,
  5
FROM public.assets a
JOIN public.privacy_settings ps ON ps.user_id = a.user_id AND ps.face_processing_enabled = true
WHERE a.media_type IN ('photo', 'live_photo', 'animation')
  AND a.deleted_state = 'active'
ON CONFLICT (user_id, job_name, idempotency_key) DO NOTHING;
