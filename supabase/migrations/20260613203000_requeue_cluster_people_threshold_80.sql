-- Requeue clusterPeople for all users with detected faces after increasing
-- the Rekognition FaceMatchThreshold from 50 % to 80 %.
-- Higher threshold = stricter matching; existing loose duplicates may split.

delete from job_queue where job_name = 'clusterPeople';

insert into job_queue (job_name, payload, status, priority, user_id)
select
  'clusterPeople',
  jsonb_build_object('user_id', af.user_id::text),
  'pending',
  10,
  af.user_id
from (
  select distinct user_id from asset_faces where face is not null
) af
on conflict do nothing;
