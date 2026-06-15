-- RPC to fetch only FaceId strings for a user's asset_faces rows.
-- Returns only the FaceId text value from each face JSONB column — not
-- the full face object (which includes FaceCrop at ~50 KB each) — so the
-- result set stays well under Supabase's response size limit even for users
-- with thousands of indexed faces.
CREATE OR REPLACE FUNCTION get_user_face_ids(p_user_id uuid)
RETURNS TABLE(face_id text)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT face->>'FaceId' AS face_id
  FROM public.asset_faces
  WHERE user_id = p_user_id
    AND face->>'FaceId' IS NOT NULL
    AND face->>'FaceId' <> '';
$$;

GRANT EXECUTE ON FUNCTION get_user_face_ids(uuid) TO service_role;
