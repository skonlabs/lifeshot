-- Re-enqueue clusterPeople for all users so the new 80% similarity threshold
-- and relaxed attribute confidence gates (60%) take effect on existing data.
-- This will merge currently-split duplicate people rows and pick up faces that
-- were previously excluded by over-strict EyesOpen/FaceOccluded confidence gates.
insert into job_queue (user_id, job_name, payload, idempotency_key, lane, priority, max_attempts)
select distinct
  user_id,
  'clusterPeople',
  jsonb_build_object('user_id', user_id),
  'recluster-threshold80:' || user_id,
  'default',
  10,
  3
from assets
where media_type in ('photo', 'live_photo', 'animation')
  and face_scanned_at is not null
  and not exists (
    select 1 from job_queue jq
    where jq.idempotency_key = 'recluster-threshold80:' || assets.user_id
  )
on conflict (idempotency_key) do nothing;
