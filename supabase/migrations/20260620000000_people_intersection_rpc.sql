CREATE OR REPLACE FUNCTION public.people_intersection_assets(
  p_user_id    uuid,
  p_person_ids uuid[],
  p_from       timestamptz DEFAULT NULL,
  p_to         timestamptz DEFAULT NULL,
  p_k          integer     DEFAULT 100
)
RETURNS TABLE(asset_id uuid, capture_time timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT af.asset_id
    FROM   asset_faces af
    WHERE  af.user_id   = p_user_id
      AND  af.person_id = ANY(p_person_ids)
    GROUP BY af.asset_id
    HAVING COUNT(DISTINCT af.person_id) = array_length(p_person_ids, 1)
  )
  SELECT a.id AS asset_id, a.capture_time
  FROM   assets a
  JOIN   base  b ON b.asset_id = a.id
  WHERE  a.user_id       = p_user_id
    AND  a.deleted_state = 'active'
    AND  (p_from IS NULL OR a.capture_time >= p_from)
    AND  (p_to   IS NULL OR a.capture_time <= p_to)
  ORDER BY a.capture_time DESC NULLS LAST
  LIMIT  p_k;
$$;

GRANT EXECUTE ON FUNCTION public.people_intersection_assets TO authenticated, service_role;
