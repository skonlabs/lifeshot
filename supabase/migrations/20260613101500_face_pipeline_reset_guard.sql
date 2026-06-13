ALTER TABLE public.privacy_settings
  ADD COLUMN IF NOT EXISTS face_pipeline_reset_at timestamptz;
