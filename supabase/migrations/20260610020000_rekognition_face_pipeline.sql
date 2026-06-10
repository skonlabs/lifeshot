-- Add face_id (Rekognition FaceId) to person_faces for identity matching.
-- Add cover_face_crop to people for avatar display.
ALTER TABLE public.person_faces ADD COLUMN IF NOT EXISTS face_id text;
CREATE INDEX IF NOT EXISTS idx_person_faces_face_id ON public.person_faces(face_id) WHERE face_id IS NOT NULL;

ALTER TABLE public.people ADD COLUMN IF NOT EXISTS cover_face_crop text;
ALTER TABLE public.people ADD COLUMN IF NOT EXISTS cover_asset_id uuid REFERENCES public.assets(id) ON DELETE SET NULL;
ALTER TABLE public.people ADD COLUMN IF NOT EXISTS cover_bbox jsonb;
