-- Switch face detection pipeline to client-side face-api.js (128-d descriptors).
-- Disable triggers to avoid touching legacy tables (e.g. asset_labels) that no
-- longer exist in this DB but are still referenced by old triggers.
set session_replication_role = replica;
delete from public.person_faces;
delete from public.people;
set session_replication_role = default;

drop index if exists public.idx_person_faces_hnsw;
alter table public.person_faces alter column face_vector type vector(128) using null;
create index if not exists idx_person_faces_hnsw
  on public.person_faces using hnsw (face_vector vector_cosine_ops)
  with (m = 16, ef_construction = 64);

alter table public.person_faces add column if not exists face_crop text;

alter table public.assets add column if not exists face_scanned_at timestamptz;
create index if not exists idx_assets_face_scan_pending
  on public.assets(user_id, face_scanned_at)
  where face_scanned_at is null;
