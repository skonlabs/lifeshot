-- 20260611010000_enable_face_processing_and_full_rescan.sql
--
-- Fixes two root causes that prevented asset_faces and people from being populated:
--
-- 1. privacy_settings.face_processing_enabled defaults to FALSE.
--    Every user must have face_processing_enabled = TRUE or enrichAI silently
--    skips the entire face detection block, leaving asset_faces forever empty.
--    This migration sets it to TRUE for all existing users and ensures a row
--    exists for every user in auth.users (new signups already get the default;
--    this backfills existing accounts that predate the default).
--
-- 2. assets.face_scanned_at is non-null on assets from previous pipeline runs.
--    enrichAI only writes face_scanned_at AFTER it runs; the job queue uses
--    this to decide which assets need re-processing. Reset it to NULL so every
--    asset gets re-queued on the next sync / force-scan.

-- ── 1. Enable face processing for every existing user ─────────────────────────
-- Insert a row for any user who doesn't have one yet (with face processing on).
INSERT INTO public.privacy_settings (user_id, face_processing_enabled, ai_enabled)
SELECT u.id, true, true
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.privacy_settings ps WHERE ps.user_id = u.id
);

-- Enable face processing for users who already have a row.
UPDATE public.privacy_settings
SET face_processing_enabled = true
WHERE face_processing_enabled = false;

-- ── 2. Reset face_scanned_at so ALL assets are re-queued ─────────────────────
-- enrichAI will re-run on every asset and write fresh data to asset_faces.
UPDATE public.assets
SET face_scanned_at = NULL
WHERE face_scanned_at IS NOT NULL;

-- ── 3. Clear stale asset_faces data ───────────────────────────────────────────
-- asset_faces may have partial/incorrect rows from earlier broken pipeline runs.
-- A clean slate lets the fresh enrichAI writes be authoritative.
DELETE FROM public.asset_faces;

-- ── 4. Reset people auto-clustering data ─────────────────────────────────────
-- Clear auto-created people rows so clusterPeople rebuilds them cleanly from
-- the fresh asset_faces data. Only auto-clustered rows are removed (auto_label
-- LIKE 'auto:person:%'); manually named people are preserved.
DELETE FROM public.people
WHERE auto_label LIKE 'auto:person:%';

-- Report
SELECT
  (SELECT count(*) FROM public.privacy_settings WHERE face_processing_enabled = true) AS users_with_face_enabled,
  (SELECT count(*) FROM public.assets WHERE face_scanned_at IS NULL)                  AS assets_queued_for_rescan,
  (SELECT count(*) FROM public.asset_faces)                                           AS asset_faces_rows,
  (SELECT count(*) FROM public.people WHERE auto_label LIKE 'auto:person:%')          AS auto_people_rows;
