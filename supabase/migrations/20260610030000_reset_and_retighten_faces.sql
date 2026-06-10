-- Full face pipeline reset with tightened quality thresholds.
--
-- What changed: QualityFilter "AUTO" → "MEDIUM" in face-detector.ts,
-- thresholds yaw≤10°, pitch≤8°, confidence≥0.70, sharpness≥50, brightness≥30.
-- Rekognition underreports angles ~2x vs visual perception — these code-level
-- values correspond to roughly 20°/16° visually, rejecting moderate side faces.
--
-- This migration wipes all accumulated face data and forces the pipeline to
-- re-detect and re-cluster every photo from scratch with the new thresholds.

begin;

-- 1. Delete all auto-clustered people (recreated by clusterPeople).
--    Manually named people (auto_label IS NULL) are preserved.
delete from public.person_faces;
delete from public.people where auto_label is not null;

-- 2. Clear all face enrichment data so enrichAI re-detects with tighter filter.
update public.asset_ai_enrichment
set faces = '[]'::jsonb
where faces is not null and faces != '[]'::jsonb;

-- 3. Reset face_scanned_at so every asset is re-queued for enrichAI.
update public.assets
set face_scanned_at = null
where face_scanned_at is not null;

commit;

select
  (select count(*) from public.people where auto_label is null)          as manual_people_preserved,
  (select count(*) from public.people)                                    as total_people_after,
  (select count(*) from public.person_faces)                              as person_faces_after,
  (select count(*) from public.assets where face_scanned_at is null)     as assets_queued_for_rescan;
