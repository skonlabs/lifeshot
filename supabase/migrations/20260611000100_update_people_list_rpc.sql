-- 20260611000100_update_people_list_rpc.sql
-- Refresh people_list_for_user after the asset_faces pipeline redesign.
-- person_faces is gone; people.faces JSONB is now the sole source of
-- per-occurrence face data. Strip heavy blobs (face_crop) from the list
-- result; include cover_face_crop separately for the avatar thumbnail.

CREATE OR REPLACE FUNCTION public.people_list_for_user(_user_id uuid)
RETURNS TABLE (
  id                uuid,
  display_name      text,
  is_child          boolean,
  is_elder          boolean,
  consent_required  boolean,
  auto_label        text,
  face_count        int,
  cover_asset_id    uuid,
  cover_bbox        jsonb,
  cover_face_crop   text,
  faces             jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id,
    p.display_name,
    p.is_child,
    p.is_elder,
    p.consent_required,
    p.auto_label,
    p.face_count,
    p.cover_asset_id,
    p.cover_bbox,
    p.cover_face_crop,
    -- Strip face_crop blobs from the per-occurrence list (they're large);
    -- include Pose/Quality/FaceOccluded attributes for client-side avatar scoring.
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'asset_id',             f->>'asset_id',
          'bbox',                 f->'bbox',
          'confidence',           f->'confidence',
          'rekognition_face_id',  f->>'rekognition_face_id',
          'attributes',           jsonb_build_object(
            'Pose',         f->'attributes'->'Pose',
            'Quality',      f->'attributes'->'Quality',
            'FaceOccluded', f->'attributes'->'FaceOccluded',
            'EyeDirection', f->'attributes'->'EyeDirection'
          )
        )
      )
      FROM jsonb_array_elements(COALESCE(p.faces, '[]'::jsonb)) AS f
    ), '[]'::jsonb) AS faces
  FROM public.people p
  WHERE p.user_id = _user_id;
$$;

GRANT EXECUTE ON FUNCTION public.people_list_for_user(uuid) TO authenticated, service_role;
