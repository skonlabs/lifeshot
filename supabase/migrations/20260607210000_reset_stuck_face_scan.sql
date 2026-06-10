-- Reset face_scanned_at for assets that were marked scanned while
-- Rekognition was not configured. Their faces array is empty and they
-- will never be retried unless we clear the marker.
update public.assets a
set face_scanned_at = null
where a.face_scanned_at is not null
  and not exists (
    select 1 from public.asset_ai_enrichment e
    where e.asset_id = a.id
      and jsonb_typeof(e.faces) = 'array'
      and jsonb_array_length(e.faces) > 0
  );

-- Re-enqueue enrichAI for those assets. Unique on (user_id, job_name, idempotency_key).
insert into public.job_queue (user_id, job_name, payload, status, priority, idempotency_key, scheduled_at, lane, max_attempts)
select a.user_id, 'enrichAI',
       jsonb_build_object('asset_id', a.id), 'pending', 5,
       'ai:rescan:' || a.id, now(), 'default', 3
from public.assets a
where a.face_scanned_at is null
  and a.media_type in ('photo','live_photo','animation')
on conflict (user_id, job_name, idempotency_key) do nothing;
