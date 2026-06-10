-- 20260610120000_people_face_pipeline_schema.sql
-- Adds columns and constraints required by the face clustering pipeline.
-- Without these, all upserts in clusterPeople silently fail and
-- people / person_faces tables are never populated.

-- ── people: add clustering metadata columns ──────────────────────────────────
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS auto_label           text,
  ADD COLUMN IF NOT EXISTS faces                jsonb    NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS face_count           integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rekognition_face_ids text[]   NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS cover_face_crop      text,
  ADD COLUMN IF NOT EXISTS cover_asset_id       uuid REFERENCES public.assets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cover_bbox           jsonb;

-- Unique index on (user_id, auto_label) WHERE auto_label IS NOT NULL.
-- This is the conflict target for upsert in clusterPeople.
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_user_auto_label
  ON public.people(user_id, auto_label)
  WHERE auto_label IS NOT NULL;

-- ── person_faces: add missing columns + unique constraint ─────────────────────
ALTER TABLE public.person_faces
  ADD COLUMN IF NOT EXISTS rekognition_face_id text,
  ADD COLUMN IF NOT EXISTS face_crop           text;

-- Unique constraint required for upsert onConflict: "person_id,asset_id".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'person_faces_person_id_asset_id_key'
      AND conrelid = 'public.person_faces'::regclass
  ) THEN
    ALTER TABLE public.person_faces
      ADD CONSTRAINT person_faces_person_id_asset_id_key
      UNIQUE (person_id, asset_id);
  END IF;
END $$;
