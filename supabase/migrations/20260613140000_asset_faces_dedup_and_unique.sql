-- Fix: duplicate rows in asset_faces.
--
-- The 20260613100000 schema redesign moved face_id into the `face` jsonb blob
-- and dropped the unique (asset_id, face_id) index. storeFaceResults does a
-- non-transactional delete-then-insert, so concurrent enrichAI runs for the
-- same asset (retry, re-scan, duplicate enqueue) interleave and both inserts
-- land — producing duplicate (asset_id, FaceId) rows.

-- 1. Dedup existing rows, keep most recent per (asset_id, FaceId).
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY asset_id, (face->>'FaceId')
           ORDER BY created_at DESC, id DESC
         ) AS rn
  FROM public.asset_faces
  WHERE face ? 'FaceId'
)
DELETE FROM public.asset_faces af
USING ranked r
WHERE af.id = r.id AND r.rn > 1;

-- 2. Unique index on (asset_id, FaceId).
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_faces_asset_face_id
  ON public.asset_faces (asset_id, ((face->>'FaceId')))
  WHERE face ? 'FaceId';

-- 3. Transactional replace RPC.
CREATE OR REPLACE FUNCTION public.replace_asset_faces(
  p_asset_id uuid,
  p_user_id  uuid,
  p_faces    jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  written integer := 0;
  face_ids text[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT (f->>'FaceId')), '{}')
    INTO face_ids
    FROM jsonb_array_elements(COALESCE(p_faces, '[]'::jsonb)) AS f
   WHERE f->>'FaceId' IS NOT NULL;

  DELETE FROM public.asset_faces
   WHERE asset_id = p_asset_id
     AND ((face->>'FaceId') IS NULL OR NOT ((face->>'FaceId') = ANY (face_ids)));

  INSERT INTO public.asset_faces (asset_id, user_id, face)
  SELECT p_asset_id, p_user_id, f
    FROM jsonb_array_elements(COALESCE(p_faces, '[]'::jsonb)) AS f
   WHERE f->>'FaceId' IS NOT NULL
  ON CONFLICT (asset_id, ((face->>'FaceId'))) WHERE face ? 'FaceId'
  DO UPDATE SET face = EXCLUDED.face, updated_at = now();

  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END;
$$;

GRANT EXECUTE ON FUNCTION public.replace_asset_faces(uuid, uuid, jsonb) TO service_role;
