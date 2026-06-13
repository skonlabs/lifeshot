-- Align search rebuild helpers with the current schema and remove the orphaned
-- embedding RPC that still references a dropped table.

CREATE OR REPLACE FUNCTION public.rebuild_search_doc(_asset_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _content text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.assets WHERE id = _asset_id) THEN RETURN; END IF;

  SELECT concat_ws(' \',
    (SELECT ocr_text FROM public.asset_ai_enrichment WHERE asset_id = _asset_id),
    (SELECT concat_ws(', \',
            reverse_geocoded_city,
            reverse_geocoded_state,
            reverse_geocoded_country,
            place_name)
       FROM public.asset_gps
      WHERE asset_id = _asset_id),
    (SELECT concat_ws(' \', device_make, device_model)
       FROM public.assets
      WHERE id = _asset_id),
    (SELECT filename FROM public.assets WHERE id = _asset_id),
    (SELECT parent_folder_path FROM public.assets WHERE id = _asset_id)
  ) INTO _content;

  UPDATE public.assets
     SET search_content = COALESCE(_content, '')
   WHERE id = _asset_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.rebuild_search_doc_with_ai(_asset_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _content text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.assets WHERE id = _asset_id) THEN RETURN; END IF;

  SELECT concat_ws(' \',
    (SELECT caption FROM public.asset_ai_enrichment WHERE asset_id = _asset_id),
    (SELECT array_to_string(ARRAY(
        SELECT jsonb_array_elements_text(COALESCE(tags, '[]'::jsonb))
      ), ' ' )
       FROM public.asset_ai_enrichment
      WHERE asset_id = _asset_id),
    (SELECT ocr_text FROM public.asset_ai_enrichment WHERE asset_id = _asset_id),
    (SELECT concat_ws(', \',
            reverse_geocoded_city,
            reverse_geocoded_state,
            reverse_geocoded_country,
            place_name)
       FROM public.asset_gps
      WHERE asset_id = _asset_id),
    (SELECT concat_ws(' \', device_make, device_model)
       FROM public.assets
      WHERE id = _asset_id),
    (SELECT filename FROM public.assets WHERE id = _asset_id),
    (SELECT parent_folder_path FROM public.assets WHERE id = _asset_id)
  ) INTO _content;

  UPDATE public.assets
     SET search_content = COALESCE(_content, '')
   WHERE id = _asset_id;
END;
$$;

DROP FUNCTION IF EXISTS public.match_assets_by_embedding(vector, integer, timestamptz, timestamptz);
