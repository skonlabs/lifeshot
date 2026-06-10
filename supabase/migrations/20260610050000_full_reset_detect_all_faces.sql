-- Full reset for revised pipeline: detect ALL faces (no quality filter at
-- detection time), select best-quality face as cover avatar per person.
-- Wipes all accumulated face/people data so the pipeline rebuilds cleanly.

begin;

delete from public.person_faces;
delete from public.people where auto_label is not null;

update public.asset_ai_enrichment
set faces = '[]'::jsonb
where faces is not null and faces != '[]'::jsonb;

update public.assets
set face_scanned_at = null
where face_scanned_at is not null;

commit;

select
  (select count(*) from public.people where auto_label is null)      as manual_people_preserved,
  (select count(*) from public.person_faces)                          as person_faces_cleared,
  (select count(*) from public.assets where face_scanned_at is null) as assets_queued;
