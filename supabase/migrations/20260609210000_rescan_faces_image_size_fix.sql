-- Reset face_scanned_at so all assets are re-processed with:
--   1. Corrected Rekognition image size limit (3.75 MB raw instead of 5 MB)
--   2. Relaxed face-box MAX_SIDE/MAX_AREA limits (accepts close-up selfies)
--   3. Idempotent clusterPeople job key (no duplicate cluster runs)
update public.assets
set face_scanned_at = null
where face_scanned_at is not null;
