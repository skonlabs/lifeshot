-- 20260611000000_asset_faces_pipeline_redesign.sql
-- Redesign the face pipeline:
--   1. asset_faces   — raw face detection results for EVERY face in EVERY asset
--                      (no quality filter; all Rekognition attributes preserved)
--   2. people        — only faces where FaceOccluded=false AND confidence≥90%
--                      (people.faces jsonb replaces person_faces junction table)
--   3. asset_ai_enrichment.rekognition_response — full IndexFaces JSON per asset
--   4. DROP person_faces — superseded by asset_faces + people.faces jsonb

-- ── 1. asset_faces ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.asset_faces (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    uuid        NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES auth.users(id)   ON DELETE CASCADE,
  face_id     text,                   -- AWS Rekognition FaceId (null if IndexFaces rejected it)
  bbox        jsonb,                  -- BoundingBox {x, y, w, h} as image fractions
  confidence  numeric,               -- detection confidence 0-1
  face_crop   text,                   -- landmark-cropped JPEG as base64 data-URL
  attributes  jsonb,                  -- full FaceDetail JSON from IndexFaces (DetectionAttributes=ALL)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX  IF NOT EXISTS idx_asset_faces_asset   ON public.asset_faces(asset_id);
CREATE INDEX  IF NOT EXISTS idx_asset_faces_user    ON public.asset_faces(user_id);
CREATE INDEX  IF NOT EXISTS idx_asset_faces_face_id ON public.asset_faces(face_id) WHERE face_id IS NOT NULL;
-- Unique per asset+face so re-scans upsert cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_faces_asset_face
  ON public.asset_faces(asset_id, face_id) WHERE face_id IS NOT NULL;

ALTER TABLE public.asset_faces ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.asset_faces TO authenticated;
GRANT ALL    ON public.asset_faces TO service_role;
CREATE POLICY asset_faces_owner ON public.asset_faces
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- ── 2. asset_ai_enrichment: add rekognition_response column ──────────────────
-- Stores the raw IndexFaces response array (each element = one FaceDetail with
-- all attributes: BoundingBox, Pose, Quality, Landmarks, Emotions, etc.)
ALTER TABLE public.asset_ai_enrichment
  ADD COLUMN IF NOT EXISTS rekognition_response jsonb;

COMMENT ON COLUMN public.asset_ai_enrichment.rekognition_response IS
  'Full AWS Rekognition IndexFaces response — array of FaceDetail objects (DetectionAttributes=ALL).';

-- ── 3. Drop person_faces ──────────────────────────────────────────────────────
-- Superseded by:
--   • asset_faces   — per-asset raw face rows (all quality levels)
--   • people.faces  — JSONB array of quality-filtered face occurrences per person
-- CASCADE drops dependent indexes, constraints, and policies automatically.
DROP TABLE IF EXISTS public.person_faces CASCADE;
