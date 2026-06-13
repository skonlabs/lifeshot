-- The merge_person_faces RPC (migration 20260612040000) was deployed before
-- the DB function existed, so all clusterPeople jobs failed after writing
-- empty person rows (rekognition_face_ids=[]).  Without face IDs on person
-- rows, subsequent runs can never match faces to people, causing unbounded
-- duplicate person creation.
--
-- This migration:
--   1. Removes the empty/broken auto-person rows.
--   2. Clears failed/dead-letter clusterPeople jobs so fresh ones can queue.
--   3. Re-queues clusterPeople for every user who has asset_faces rows and
--      face_processing_enabled, using a new idempotency prefix so the
--      job_ledger doesn't suppress them.

-- 1. Delete auto-person rows with no rekognition face IDs (the broken shells).
DELETE FROM people
WHERE auto_label LIKE 'auto:person:%'
  AND (rekognition_face_ids IS NULL OR rekognition_face_ids = '{}');

-- 2. Remove failed/pending clusterPeople jobs so retries don't stack.
DELETE FROM job_queue
WHERE job_name = 'clusterPeople'
  AND status IN ('pending', 'failed', 'dead');

-- 3. Enqueue one fresh clusterPeople per qualifying user.
--    idempotency prefix 'cluster-fix1:' is distinct from any prior prefix.
INSERT INTO job_queue (user_id, job_name, payload, status, priority, lane, next_attempt_at, idempotency_key, max_attempts)
SELECT DISTINCT
  af.user_id,
  'clusterPeople',
  jsonb_build_object('user_id', af.user_id),
  'pending',
  5,
  'ai',
  NOW(),
  'cluster-fix1:' || af.user_id,
  5
FROM asset_faces af
JOIN privacy_settings ps ON ps.user_id = af.user_id AND ps.face_processing_enabled = true
WHERE af.face_id IS NOT NULL
ON CONFLICT (user_id, job_name, idempotency_key) DO NOTHING;
