-- Create person_faces table if it doesn't exist (may have been dropped in a prior reset).
-- Stores one row per face occurrence per person across assets.
CREATE TABLE IF NOT EXISTS public.person_faces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  asset_id    uuid NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  face_id     text,                     -- AWS Rekognition FaceId
  bbox        jsonb,                    -- normalized {x,y,w,h} 0..1
  confidence  double precision,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_person_faces_person  ON public.person_faces(person_id);
CREATE INDEX IF NOT EXISTS idx_person_faces_asset   ON public.person_faces(asset_id);
CREATE INDEX IF NOT EXISTS idx_person_faces_face_id ON public.person_faces(face_id) WHERE face_id IS NOT NULL;

-- Add cover columns to people for Rekognition pipeline avatar display.
ALTER TABLE public.people ADD COLUMN IF NOT EXISTS cover_face_crop  text;
ALTER TABLE public.people ADD COLUMN IF NOT EXISTS cover_asset_id   uuid REFERENCES public.assets(id) ON DELETE SET NULL;
ALTER TABLE public.people ADD COLUMN IF NOT EXISTS cover_bbox        jsonb;
