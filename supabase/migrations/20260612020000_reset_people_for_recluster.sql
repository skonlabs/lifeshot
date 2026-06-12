-- 20260612020000_reset_people_for_recluster.sql
--
-- The people table was flooded with duplicate / incorrect entries due to
-- three bugs that are now fixed in clusterPeople.ts:
--
--   1. Dual-write: storeFaceResults AND clusterPeople both wrote to people,
--      creating a concurrent race that generated duplicate person rows.
--   2. personCounter = existingPeople.length instead of MAX(label N) caused
--      collisions when labels had gaps.
--   3. Per-asset clusterPeople runs REPLACED people.faces instead of merging,
--      so faces from other assets were silently wiped.
--
-- Fix: wipe all auto-generated people, clear asset_faces so the pipeline
-- re-indexes every face into a clean Rekognition collection, and re-queue
-- enrichAI for all photos so they go through the corrected pipeline.
--
-- Manual / named people (display_name set by user, auto_label IS NULL or
-- does NOT match 'auto:person:%') are preserved.

-- ── 1. Delete all auto-generated person rows ──────────────────────────────────
delete from public.people
 where auto_label like 'auto:person:%';

-- ── 2. Clear asset_faces so re-scan starts clean ──────────────────────────────
delete from public.asset_faces;

-- ── 3. Reset face_scanned_at so enrichAI will re-process every photo ─────────
update public.assets
   set face_scanned_at = null
 where media_type in ('photo', 'live_photo', 'animation');

-- ── 4. Cancel any pending/running enrichAI and clusterPeople jobs ────────────
-- (they reference now-deleted faces; easier to start fresh)
update public.job_queue
   set status      = 'cancelled',
       finished_at = now(),
       updated_at  = now()
 where job_name in ('enrichAI', 'clusterPeople')
   and status in ('pending', 'running')
   and dead_letter = false;

-- ── 5. Re-enqueue enrichAI for every photo ────────────────────────────────────
insert into public.job_queue (
  user_id, job_name, payload, idempotency_key,
  lane, priority, max_attempts, next_attempt_at
)
select
  a.user_id,
  'enrichAI',
  jsonb_build_object('asset_id', a.id),
  'ai:recluster:' || a.id,
  'ai',
  20,
  5,
  now()
from public.assets a
where a.media_type in ('photo', 'live_photo', 'animation')
on conflict (user_id, job_name, idempotency_key) do update
  set status          = 'pending',
      attempts        = 0,
      locked_at       = null,
      locked_by       = null,
      finished_at     = null,
      next_attempt_at = now(),
      dead_letter     = false,
      last_error      = null,
      updated_at      = now();

-- ── Diagnostic counts ─────────────────────────────────────────────────────────
select
  (select count(*) from public.people where auto_label like 'auto:person:%') as auto_people_remaining,
  (select count(*) from public.asset_faces)                                   as asset_faces_remaining,
  (select count(*) from public.assets
    where face_scanned_at is null
      and media_type in ('photo','live_photo','animation'))                    as photos_queued_for_scan,
  (select count(*) from public.job_queue
    where job_name = 'enrichAI' and status = 'pending' and dead_letter = false) as enrichai_pending;
