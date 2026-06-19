-- Fresh recluster: clear all people assignments so clusterPeople starts with
-- no prior person_id links and clusters every face from scratch using the
-- current 80% similarity threshold.
--
-- This does NOT touch the Rekognition collection or asset_faces face data —
-- it only clears the clustering output (people rows + person_id links).
-- All face crops, FaceIds, and quality scores are preserved.
--
-- After this runs the enqueued clusterPeople job will re-cluster everything.

-- 1. Null out all person_id links in asset_faces
update public.asset_faces
   set person_id = null,
       updated_at = now()
 where person_id is not null;

-- 2. Delete all people rows (all are auto-named "Person N", no custom names lost)
delete from public.people;

-- 3. Enqueue clusterPeople for every user that has scanned faces
insert into job_queue (user_id, job_name, payload, idempotency_key, lane, priority, max_attempts)
select distinct
  a.user_id,
  'clusterPeople',
  jsonb_build_object('user_id', a.user_id),
  'fresh-recluster:' || a.user_id,
  'default',
  20,
  3
from public.assets a
where a.face_scanned_at is not null
  and not exists (
    select 1 from job_queue jq
    where jq.idempotency_key = 'fresh-recluster:' || a.user_id
      and jq.status in ('pending', 'running')
  )
on conflict (user_id, job_name, idempotency_key) do nothing;
