-- Backfill schema drift for environments that missed the Rekognition switch.
-- clusterPeople reads and writes these columns; without them the people/faces
-- pipeline stays empty and ad-hoc verification queries fail.

ALTER TABLE public.person_faces
  ADD COLUMN IF NOT EXISTS rekognition_face_id text;

CREATE INDEX IF NOT EXISTS idx_person_faces_rek_face_id
  ON public.person_faces(rekognition_face_id)
  WHERE rekognition_face_id IS NOT NULL;

ALTER TABLE public.person_faces
  ADD COLUMN IF NOT EXISTS rekognition_response jsonb;

COMMENT ON COLUMN public.person_faces.rekognition_face_id IS
  'AWS Rekognition FaceId used for SearchFaces matching and duplicate prevention.';

COMMENT ON COLUMN public.person_faces.rekognition_response IS
  'Full AWS Rekognition FaceDetail JSON returned by IndexFaces (DetectionAttributes=ALL).';
