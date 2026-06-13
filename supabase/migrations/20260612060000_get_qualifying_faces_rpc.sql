-- Push the face quality gate into PostgreSQL so clusterPeople never needs to
-- pull the heavy `attributes` JSON over the network.
--
-- Returns only the lightweight columns needed for clustering: asset_id, face_id,
-- bbox, confidence.  The edge function fetches attributes+face_crop separately
-- for the chosen cover face only (a single targeted row).
--
-- Quality conditions:
--   FaceOccluded.Value = false  (not occluded)
--   Confidence > 90             (high detection confidence)
--   |Pose.Yaw|   < 40°         (not a side profile)
--   |Pose.Pitch| < 35°         (not severely tilted)

CREATE OR REPLACE FUNCTION get_qualifying_faces(
  p_user_id  uuid,
  p_asset_id uuid DEFAULT NULL
)
RETURNS TABLE(asset_id uuid, face_id text, bbox jsonb, confidence numeric)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT
    af.asset_id,
    af.face_id,
    af.bbox,
    af.confidence
  FROM public.asset_faces af
  WHERE af.user_id  = p_user_id
    AND af.face_id IS NOT NULL
    AND af.attributes ->'FaceOccluded'->>'Value' = 'false'
    AND (af.attributes->>'Confidence')::numeric        >  90
    AND abs((af.attributes->'Pose'->>'Yaw')::numeric)  < 40
    AND abs((af.attributes->'Pose'->>'Pitch')::numeric)< 35
    AND (p_asset_id IS NULL OR af.asset_id = p_asset_id);
$$;

GRANT EXECUTE ON FUNCTION get_qualifying_faces(uuid, uuid) TO service_role;
