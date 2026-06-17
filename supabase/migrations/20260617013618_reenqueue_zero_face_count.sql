-- Re-enqueue enrichAI for assets that show face_count=0 but may have been
-- processed with broken image-URL resolution (uploads bucket not checked).
-- After the code fix that tries both derived and uploads storage buckets,
-- these assets should now resolve their images and complete Rekognition.
--
-- IMPORTANT: Only insert new jobs for assets that have NO existing
-- pending/running enrichAI job. Two concurrent enrichAI jobs for the same
-- asset both call Rekognition IndexFaces, creating duplicate FaceIds that
-- become permanently orphaned in the collection and corrupt clusterPeople.

insert into public.job_queue (
  user_id, job_name, payload, lane, priority,
  idempotency_key, max_attempts, status, next_attempt_at
)
select
  a.user_id,
  'enrichAI',
  jsonb_build_object('asset_id', a.id),
  'default',
  5,
  'reenrich-bucket-fix:' || a.id,
  5,
  'pending',
  now()
from public.assets a
join public.asset_ai_enrichment e on e.asset_id = a.id
where a.media_type in ('photo', 'live_photo', 'animation')
  and (e.face_count = 0 or e.face_count is null)
  -- Skip assets that already have a pending or running enrichAI job — running
  -- two IndexFaces calls concurrently for the same asset orphans FaceIds in
  -- the Rekognition collection and causes duplicate people records.
  and not exists (
    select 1 from public.job_queue jq
    where jq.job_name = 'enrichAI'
      and jq.status in ('pending', 'running')
      and jq.payload->>'asset_id' = a.id::text
  )
on conflict (idempotency_key) do nothing;

-- Also enqueue generateDerived to rebuild derivatives from the uploads bucket
-- for any asset that has no derived storage paths yet.
insert into public.job_queue (
  user_id, job_name, payload, lane, priority,
  idempotency_key, max_attempts, status, next_attempt_at
)
select
  a.user_id,
  'generateDerived',
  jsonb_build_object('asset_id', a.id),
  'default',
  6,
  'rederive-bucket-fix:' || a.id,
  5,
  'pending',
  now()
from public.assets a
join public.asset_ai_enrichment e on e.asset_id = a.id
left join public.asset_media_metadata mm on mm.asset_id = a.id
where a.media_type in ('photo', 'live_photo', 'animation')
  and (e.face_count = 0 or e.face_count is null)
  and mm.preview_storage_path is null
  and not exists (
    select 1 from public.job_queue jq
    where jq.job_name = 'generateDerived'
      and jq.status in ('pending', 'running')
      and jq.payload->>'asset_id' = a.id::text
  )
on conflict (idempotency_key) do nothing;

select
  (select count(*) from public.job_queue where job_name = 'enrichAI' and idempotency_key like 'reenrich-bucket-fix:%' and status = 'pending') as enrichai_enqueued,
  (select count(*) from public.job_queue where job_name = 'generateDerived' and idempotency_key like 'rederive-bucket-fix:%' and status = 'pending') as derived_enqueued;
