-- Ensure all columns needed by the Rekognition face pipeline exist.
-- Safe to apply multiple times (IF NOT EXISTS throughout).

-- people: clustering + cover fields
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS auto_label           text,
  ADD COLUMN IF NOT EXISTS faces                jsonb    NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS face_count           integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rekognition_face_ids text[]   NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS cover_face_crop      text,
  ADD COLUMN IF NOT EXISTS cover_asset_id       uuid REFERENCES public.assets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cover_bbox           jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_people_user_auto_label
  ON public.people(user_id, auto_label)
  WHERE auto_label IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_people_rekog_face_ids
  ON public.people USING gin(rekognition_face_ids);

-- person_faces: Rekognition fields the pipeline writes
ALTER TABLE public.person_faces
  ADD COLUMN IF NOT EXISTS rekognition_face_id text,
  ADD COLUMN IF NOT EXISTS face_crop           text;

CREATE INDEX IF NOT EXISTS idx_person_faces_rek_face_id
  ON public.person_faces(rekognition_face_id)
  WHERE rekognition_face_id IS NOT NULL;

-- Unique constraint on (person_id, asset_id) — needed for upsert
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'person_faces_person_id_asset_id_key'
      AND conrelid = 'public.person_faces'::regclass
  ) THEN
    ALTER TABLE public.person_faces ADD CONSTRAINT person_faces_person_id_asset_id_key UNIQUE (person_id, asset_id);
  END IF;
END $$;
