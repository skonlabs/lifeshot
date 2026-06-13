-- One-row-per-person model.
--
-- Before: `people` had one row per (asset_id, face) detection — many duplicate
-- rows with the same display_name for one human.
--
-- After: `people` has exactly one row per unique person.
--   * face_ids text[] — all Rekognition FaceIds belonging to this person.
--   * asset_id / face — cover face (best detection for the avatar).
--   * asset_faces.person_id uuid — every detection links to its person.

-- 1. Schema
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS face_ids text[] NOT NULL DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS idx_people_face_ids_gin
  ON public.people USING gin (face_ids);

ALTER TABLE public.asset_faces
  ADD COLUMN IF NOT EXISTS person_id uuid
    REFERENCES public.people(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_asset_faces_person_id
  ON public.asset_faces(person_id);

-- 2. Backfill: collapse duplicates per (user_id, display_name).
DO $mig$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    WITH rk AS (
      SELECT
        p.id,
        p.user_id,
        p.display_name,
        p.face->>'FaceId' AS face_id,
        (
          GREATEST(0, 1 - LEAST(90, abs(COALESCE((p.face->'FaceDetail'->'Pose'->>'Yaw')::numeric,   90))) / 90.0)
        * GREATEST(0, 1 - LEAST(90, abs(COALESCE((p.face->'FaceDetail'->'Pose'->>'Pitch')::numeric, 90))) / 90.0)
        ) * 0.60
        + COALESCE((p.face->'FaceDetail'->'Quality'->>'Sharpness')::numeric,  0)/100.0 * 0.25
        + COALESCE((p.face->'FaceDetail'->'Quality'->>'Brightness')::numeric, 0)/100.0 * 0.15
          AS quality
      FROM public.people p
      WHERE p.user_id IS NOT NULL
    ),
    sv AS (
      SELECT DISTINCT ON (user_id, COALESCE(display_name, ''))
        id AS survivor_id, user_id, display_name
      FROM rk
      ORDER BY user_id, COALESCE(display_name, ''), quality DESC, id
    )
    SELECT
      sv.survivor_id,
      array_agg(DISTINCT rk.face_id) FILTER (WHERE rk.face_id IS NOT NULL) AS face_ids,
      array_agg(rk.id) AS group_ids
    FROM sv
    JOIN rk
      ON rk.user_id = sv.user_id
     AND COALESCE(rk.display_name, '') = COALESCE(sv.display_name, '')
    GROUP BY sv.survivor_id
  LOOP
    UPDATE public.people
       SET face_ids   = COALESCE(rec.face_ids, '{}'::text[]),
           updated_at = now()
     WHERE id = rec.survivor_id;

    UPDATE public.asset_faces af
       SET person_id = rec.survivor_id
     WHERE af.person_id IS DISTINCT FROM rec.survivor_id
       AND af.face->>'FaceId' = ANY (COALESCE(rec.face_ids, '{}'::text[]));

    DELETE FROM public.people
     WHERE id = ANY (rec.group_ids)
       AND id <> rec.survivor_id;
  END LOOP;
END $mig$;

-- 3. Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.people      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.asset_faces TO authenticated;
GRANT ALL ON public.people      TO service_role;
GRANT ALL ON public.asset_faces TO service_role;
