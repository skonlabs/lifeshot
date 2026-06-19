-- Step 1: Remove stale 200×200 FaceCrop data-URLs from all asset_faces rows.
-- This forces the People page to use the CSS zoom path with zoom_url (full-res
-- preview) immediately instead of stretching a tiny 200px JPEG to fill the avatar.
update public.asset_faces
   set face = face - 'FaceCrop'
 where face ? 'FaceCrop';

-- Step 2: Re-enqueue enrichAI for all scanned photo assets to regenerate
-- face crops at 512×512 from the full-resolution source image.
insert into job_queue (user_id, job_name, payload, idempotency_key, lane, priority, max_attempts)
select distinct
  a.user_id,
  'enrichAI',
  jsonb_build_object('asset_id', a.id),
  'crop-regen-512:' || a.id,
  'default',
  10,
  5
from public.assets a
where a.media_type in ('photo', 'live_photo', 'animation')
  and a.face_scanned_at is not null
  and not exists (
    select 1 from job_queue jq
    where jq.idempotency_key = 'crop-regen-512:' || a.id
      and jq.status in ('pending', 'running')
  )
on conflict (idempotency_key) do nothing;
