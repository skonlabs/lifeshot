-- Re-run clusterPeople for every user with faces after fixing the job to
-- reconcile across the entire user's face graph instead of only the latest asset.

delete from public.job_queue where job_name = 'clusterPeople';

delete from public.job_ledger where job_name = 'clusterPeople';

insert into public.job_queue (job_name, payload, status, priority, user_id)
select
  'clusterPeople',
  jsonb_build_object('user_id', af.user_id::text),
  'pending',
  10,
  af.user_id
from (
  select distinct user_id
  from public.asset_faces
  where face is not null
) af
on conflict do nothing;
