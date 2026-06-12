-- Atomic merge function for people.faces to eliminate the race condition in
-- clusterPeople. Without this, concurrent per-asset jobs do a read-modify-write
-- on people.faces and the last writer wins, causing earlier assets' faces to
-- disappear from the person record.
--
-- The function replaces face entries for the given assets atomically inside a
-- single UPDATE statement, so two concurrent calls for different assets produce
-- the union of both, not last-write-wins.
--
-- Cover fields are updated only when a non-null cover is supplied; NULL means
-- "keep whatever is already there", letting better covers from earlier runs persist.

CREATE OR REPLACE FUNCTION merge_person_faces(
  p_person_id           uuid,
  p_assets_to_replace   text[],
  p_new_faces           jsonb,
  p_all_face_ids        text[],
  p_cover_face_crop     text    DEFAULT NULL,
  p_cover_asset_id      text    DEFAULT NULL,
  p_cover_bbox          jsonb   DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE people SET
    faces = (
      SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
      FROM (
        -- Keep face entries from assets NOT being replaced in this run.
        SELECT elem
        FROM   jsonb_array_elements(COALESCE(faces, '[]'::jsonb)) AS elem
        WHERE  NOT (elem->>'asset_id' = ANY(p_assets_to_replace))
        UNION ALL
        -- Add fresh entries from this run.
        SELECT elem
        FROM   jsonb_array_elements(p_new_faces) AS elem
      ) merged_faces
    ),
    face_count = (
      SELECT COUNT(*)
      FROM (
        SELECT elem
        FROM   jsonb_array_elements(COALESCE(faces, '[]'::jsonb)) AS elem
        WHERE  NOT (elem->>'asset_id' = ANY(p_assets_to_replace))
        UNION ALL
        SELECT elem
        FROM   jsonb_array_elements(p_new_faces) AS elem
      ) mc
    ),
    rekognition_face_ids = (
      SELECT ARRAY_AGG(DISTINCT v)
      FROM   unnest(COALESCE(rekognition_face_ids, ARRAY[]::text[]) || p_all_face_ids) AS v
      WHERE  v IS NOT NULL
    ),
    -- Only overwrite cover fields when this run found a qualifying cover crop;
    -- NULL means "leave the existing cover in place".
    cover_face_crop = COALESCE(p_cover_face_crop, cover_face_crop),
    cover_asset_id  = CASE WHEN p_cover_face_crop IS NOT NULL THEN p_cover_asset_id ELSE cover_asset_id END,
    cover_bbox      = CASE WHEN p_cover_face_crop IS NOT NULL THEN p_cover_bbox      ELSE cover_bbox      END
  WHERE id = p_person_id;
END;
$$;

-- Grant execute to service_role so the edge function can call it.
GRANT EXECUTE ON FUNCTION merge_person_faces(uuid, text[], jsonb, text[], text, text, jsonb) TO service_role;
