-- Store the full AWS Rekognition FaceDetail JSON per face for richer
-- downstream features (age, gender, emotions, landmarks, pose, quality).
ALTER TABLE public.person_faces
  ADD COLUMN IF NOT EXISTS rekognition_response jsonb;

COMMENT ON COLUMN public.person_faces.rekognition_response IS
  'Full AWS Rekognition FaceDetail JSON returned by IndexFaces (DetectionAttributes=ALL).';
