-- Requeue clusterPeople after removing crop-to-crop CompareFaces fallback.
-- Matching now relies solely on Rekognition SearchFaces with a similarity
-- threshold (the confidence number) passed directly to the API.

delete from public.job_queue
where job_name = 'clusterPeople'
  and status in ('queued', 'failed');

insert into public.job_queue (user_id, job_name, payload, status)
select distinct af.user_id, 'clusterPeople', jsonb_build_object('user_id', af.user_id), 'queued'
from public.asset_faces af
where af.user_id is not null;
