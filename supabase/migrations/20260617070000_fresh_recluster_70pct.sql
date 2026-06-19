-- Fresh recluster with 70% similarity threshold.
-- Previous recluster (20260617060000) used 80% which is still too strict
-- for family photos spanning different years, lighting, and expressions.
-- Rekognition commonly scores the same person at 70-85% across varied shots.

-- 1. Null out all person_id links
update public.asset_faces
   set person_id = null,
       updated_at = now()
 where person_id is not null;

-- 2. Delete all people rows
delete from public.people;

-- 3. Enqueue clusterPeople at highest priority
insert into job_queue (user_id, job_name, payload, idempotency_key, lane, priority, max_attempts)
select distinct
  a.user_id,
  'clusterPeople',
  jsonb_build_object('user_id', a.user_id),
  'fresh-recluster-70pct:' || a.user_id,
  'default',
  30,
  3
from public.assets a
where a.face_scanned_at is not null
  and not exists (
    select 1 from job_queue jq
    where jq.idempotency_key = 'fresh-recluster-70pct:' || a.user_id
      and jq.status in ('pending', 'running')
  )
on conflict (idempotency_key) do nothing;
