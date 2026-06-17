-- Re-enqueue enrichAI for all scanned photo assets to regenerate high-quality
-- face crops (512px, quality 0.92, from full-resolution source image).
-- Also re-enqueue clusterPeople once per user to merge duplicate people rows
-- and re-cluster with relaxed quality thresholds (maxYaw 45°, maxPitch 35°).

-- Re-enqueue enrichAI for every photo/live_photo/animation that has already
-- been scanned (face_scanned_at IS NOT NULL). The new crop pipeline uses the
-- full-res original image and generates 512px crops instead of 300px.
-- NOT EXISTS guard prevents creating duplicates if already pending.
insert into job_queue (user_id, job_name, payload, idempotency_key, lane, priority, max_attempts)
select distinct
  a.user_id,
  'enrichAI',
  jsonb_build_object('asset_id', a.id),
  'hq-crop-regen:' || a.id,
  'default',
  5,
  5
from assets a
join asset_ai_enrichment e on e.asset_id = a.id
where a.media_type in ('photo', 'live_photo', 'animation')
  and a.face_scanned_at is not null
  and not exists (
    select 1 from job_queue jq
    where jq.idempotency_key = 'hq-crop-regen:' || a.id
  )
on conflict (idempotency_key) do nothing;

-- Re-enqueue clusterPeople once per user to merge duplicates and re-cluster
-- with the relaxed thresholds.
insert into job_queue (user_id, job_name, payload, idempotency_key, lane, priority, max_attempts)
select distinct
  a.user_id,
  'clusterPeople',
  jsonb_build_object('user_id', a.user_id),
  'recluster-dedup:' || a.user_id,
  'default',
  3,
  3
from assets a
where a.media_type in ('photo', 'live_photo', 'animation')
  and a.face_scanned_at is not null
  and not exists (
    select 1 from job_queue jq
    where jq.idempotency_key = 'recluster-dedup:' || a.user_id
  )
on conflict (idempotency_key) do nothing;
