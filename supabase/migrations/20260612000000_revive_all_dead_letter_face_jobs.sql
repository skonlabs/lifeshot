-- 20260612000000_revive_all_dead_letter_face_jobs.sql
--
-- 1. Revive ALL dead-lettered enrichAI and clusterPeople jobs so they
--    are retried from the beginning. The previous migration (20260611160000)
--    only revived jobs with last_error '%not found: asset%'. Jobs that failed
--    for other reasons (Rekognition timeouts, preview URL not ready, DB
--    transient errors, etc.) were still stuck.
--
-- 2. Reset face_scanned_at on any photo asset that has no asset_faces rows.
--    These are assets that were either (a) scanned before Rekognition was
--    configured, or (b) whose enrichAI job failed before inserting faces.
--    Resetting lets the pipeline re-queue them automatically.
--
-- 3. Re-enqueue enrichAI for every photo asset that still has no face data
--    and no pending/running enrichAI job in the queue.

-- ── 1. Revive dead-lettered enrichAI and clusterPeople jobs ──────────────────
update public.job_queue
   set status          = 'pending',
       dead_letter     = false,
       attempts        = 0,
       locked_at       = null,
       locked_by       = null,
       finished_at     = null,
       next_attempt_at = now(),
       last_error      = null,
       updated_at      = now()
 where dead_letter = true
   and job_name in ('enrichAI', 'clusterPeople');

-- ── 2. Reset face_scanned_at on un-scanned photos ────────────────────────────
-- Photo assets that have face_scanned_at set but zero asset_faces rows were
-- stamped as "done" during a run where Rekognition returned no faces (e.g.
-- credentials not set, collection reset, or pipeline error after the stamp).
update public.assets a
   set face_scanned_at = null
 where a.face_scanned_at is not null
   and a.media_type in ('photo', 'live_photo', 'animation')
   and not exists (
     select 1 from public.asset_faces af where af.asset_id = a.id
   );

-- ── 3. Re-enqueue enrichAI for photos with no face data and no pending job ───
insert into public.job_queue (
  user_id, job_name, payload, idempotency_key,
  lane, priority, max_attempts, next_attempt_at
)
select
  a.user_id,
  'enrichAI',
  jsonb_build_object('asset_id', a.id),
  'ai:rescan2:' || a.id,
  'ai',
  20,
  5,
  now()
from public.assets a
where a.media_type in ('photo', 'live_photo', 'animation')
  and a.face_scanned_at is null
  and not exists (
    select 1 from public.asset_faces af where af.asset_id = a.id
  )
  and not exists (
    select 1 from public.job_queue jq
     where jq.job_name = 'enrichAI'
       and (jq.payload->>'asset_id') = a.id::text
       and jq.status in ('pending', 'running')
       and jq.dead_letter = false
  )
on conflict (user_id, job_name, idempotency_key) do nothing;

-- ── Diagnostic counts ─────────────────────────────────────────────────────────
select
  (select count(*) from public.asset_faces)                                        as asset_faces_total,
  (select count(*) from public.people where auto_label like 'auto:person:%')        as people_total,
  (select count(*) from public.assets where face_scanned_at is null
     and media_type in ('photo','live_photo','animation'))                           as photos_pending_face_scan,
  (select count(*) from public.job_queue
    where job_name = 'enrichAI' and status = 'pending' and dead_letter = false)     as enrichai_pending,
  (select count(*) from public.job_queue
    where job_name in ('enrichAI','clusterPeople') and dead_letter = true)          as dead_lettered_before_revive;
