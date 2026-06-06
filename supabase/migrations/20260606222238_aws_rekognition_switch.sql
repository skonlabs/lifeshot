-- Switch face pipeline from browser face-api.js to AWS Rekognition (server-side).
-- Wipe legacy per-user clusters & enrichment face arrays so everything is
-- rebuilt from scratch with real Rekognition FaceIds.

set session_replication_role = replica;
delete from public.person_faces;
delete from public.people;
update public.assets set face_scanned_at = null where face_scanned_at is not null;
update public.asset_ai_enrichment set faces = '[]'::jsonb where faces is not null;
set session_replication_role = default;

-- We no longer rely on pgvector for face matching; AWS Rekognition does it.
drop index if exists public.idx_person_faces_hnsw;

-- Track each face's Rekognition FaceId so SearchFaces can map matches back
-- to the owning person row.
alter table public.person_faces add column if not exists rekognition_face_id text;
create index if not exists idx_person_faces_rek_face_id
  on public.person_faces(rekognition_face_id)
  where rekognition_face_id is not null;
