-- Re-enqueue enrichAI for all scanned photo assets to regenerate face crops
-- at a consistent 512×512px. Previous runs used Math.min(512, sourceSize)
-- which produced tiny blurry crops for small faces in group photos.
-- Also clears people + person_id links for a fresh recluster with the new
-- 70% similarity threshold once crops are regenerated.

-- 1. Re-enqueue enrichAI for all previously-scanned photo assets
insert into job_queue (user_id, job_name, payload, idempotency_key, lane, priority, max_attempts)
select distinct
  a.user_id,
  'enrichAI',
  jsonb_build_object('asset_id', a.id),
  'crop-fix-512:' || a.id,
  'default',
  10,
  5
from public.assets a
where a.media_type in ('photo', 'live_photo', 'animation')
  and a.face_scanned_at is not null
  and not exists (
    select 1 from job_queue jq
    where jq.idempotency_key = 'crop-fix-512:' || a.id
      and jq.status in ('pending', 'running')
  )
on conflict (idempotency_key) do nothing;
