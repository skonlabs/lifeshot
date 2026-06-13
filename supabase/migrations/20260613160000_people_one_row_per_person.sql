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
  r record;
BEGIN
  FOR r IN
    WITH ranked AS (
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
    survivors AS (
      SELECT DISTINCT ON (user_id, COALESCE(display_name, ''))
        id AS survivor_id, user_id, display_name
      FROM ranked
      ORDER BY user_id, COALESCE(display_name, ''), quality DESC, id
    ),
    agg AS (
      SELECT
        s.survivor_id,
        array_agg(DISTINCT r.face_id) FILTER (WHERE r.face_id IS NOT NULL) AS face_ids,
        array_agg(r.id) AS group_ids
      FROM survivors s
      JOIN ranked r
        ON r.user_id = s.user_id
       AND COALESCE(r.display_name, '') = COALESCE(s.display_name, '')
      GROUP BY s.survivor_id
    )
    SELECT * FROM agg
  LOOP
    UPDATE public.people
       SET face_ids   = COALESCE(r.face_ids, '{}'::text[]),
           updated_at = now()
     WHERE id = r.survivor_id;

    UPDATE public.asset_faces af
       SET person_id = r.survivor_id
     WHERE af.person_id IS DISTINCT FROM r.survivor_id
       AND af.face->>'FaceId' = ANY (COALESCE(r.face_ids, '{}'::text[]));

    DELETE FROM public.people
     WHERE id = ANY (r.group_ids)
       AND id <> r.survivor_id;
  END LOOP;
END $mig$;

-- 3. Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.people      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.asset_faces TO authenticated;
GRANT ALL ON public.people      TO service_role;
GRANT ALL ON public.asset_faces TO service_role;
