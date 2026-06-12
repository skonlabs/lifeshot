-- 20260612030000_force_recluster_clean.sql
--
-- Re-run of the face-pipeline reset now that the corrected edge functions
-- are deployed. Migration 20260612020000 ran before the code was updated
-- so the re-queued jobs may have used the old (buggy) code.
--
-- This migration:
--   1. Truncates asset_faces (fast, lock-free alternative to DELETE).
--   2. Deletes all auto-generated people.
--   3. Resets face_scanned_at on all photo assets.
--   4. Cancels any in-flight enrichAI / clusterPeople jobs.
--   5. Re-enqueues enrichAI for every photo asset with a fresh idempotency key.

-- ── 1. Wipe asset_faces ───────────────────────────────────────────────────────
truncate public.asset_faces;

-- ── 2. Delete auto-generated person rows ─────────────────────────────────────
delete from public.people
 where auto_label like 'auto:person:%';

-- ── 3. Reset face_scanned_at ──────────────────────────────────────────────────
update public.assets
   set face_scanned_at = null
 where media_type in ('photo', 'live_photo', 'animation');

-- ── 4. Cancel stale jobs ──────────────────────────────────────────────────────
update public.job_queue
   set status      = 'cancelled',
       finished_at = now(),
       updated_at  = now()
 where job_name in ('enrichAI', 'clusterPeople')
   and status in ('pending', 'running')
   and dead_letter = false;

-- ── 5. Enqueue enrichAI for every photo (fresh idempotency key) ───────────────
insert into public.job_queue (
  user_id, job_name, payload, idempotency_key,
  lane, priority, max_attempts, next_attempt_at
)
select
  a.user_id,
  'enrichAI',
  jsonb_build_object('asset_id', a.id),
  'ai:recluster2:' || a.id,
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
  (select count(*) from public.asset_faces)                                         as asset_faces_remaining,
  (select count(*) from public.people where auto_label like 'auto:person:%')        as auto_people_remaining,
  (select count(*) from public.assets
    where face_scanned_at is null
      and media_type in ('photo','live_photo','animation'))                          as photos_pending_scan,
  (select count(*) from public.job_queue
    where job_name = 'enrichAI' and status = 'pending' and dead_letter = false)     as enrichai_pending;
