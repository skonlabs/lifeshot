-- Repair search document rebuild functions after B-NUKE table drops.
-- Keep them limited to currently-live tables/columns only.

CREATE OR REPLACE FUNCTION public.rebuild_search_doc(_asset_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _content text;
  _uid uuid;
BEGIN
  SELECT user_id INTO _uid FROM public.assets WHERE id = _asset_id;
  IF _uid IS NULL THEN RETURN; END IF;

  SELECT concat_ws(' ',
    (SELECT ocr_text FROM public.asset_ai_enrichment WHERE asset_id = _asset_id),
    (SELECT concat_ws(', ',
            reverse_geocoded_city,
            reverse_geocoded_state,
            reverse_geocoded_country,
            place_name)
       FROM public.asset_gps
      WHERE asset_id = _asset_id),
    (SELECT concat_ws(' ', device_make, device_model)
       FROM public.assets
      WHERE id = _asset_id),
    (SELECT filename FROM public.assets WHERE id = _asset_id),
    (SELECT parent_folder_path FROM public.assets WHERE id = _asset_id)
  ) INTO _content;

  INSERT INTO public.asset_search_documents(asset_id, user_id, content, search_tsv)
  VALUES (_asset_id, _uid, COALESCE(_content, ''), to_tsvector('english', COALESCE(_content, '')))
  ON CONFLICT (asset_id) DO UPDATE
    SET content = EXCLUDED.content,
        search_tsv = EXCLUDED.search_tsv,
        updated_at = now();
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
  _uid uuid;
BEGIN
  SELECT user_id INTO _uid FROM public.assets WHERE id = _asset_id;
  IF _uid IS NULL THEN RETURN; END IF;

  SELECT concat_ws(' ',
    (SELECT caption FROM public.asset_ai_enrichment WHERE asset_id = _asset_id),
    (SELECT array_to_string(ARRAY(
        SELECT jsonb_array_elements_text(COALESCE(tags, '[]'::jsonb))
      ), ' ')
       FROM public.asset_ai_enrichment
      WHERE asset_id = _asset_id),
    (SELECT ocr_text FROM public.asset_ai_enrichment WHERE asset_id = _asset_id),
    (SELECT concat_ws(', ',
            reverse_geocoded_city,
            reverse_geocoded_state,
            reverse_geocoded_country,
            place_name)
       FROM public.asset_gps
      WHERE asset_id = _asset_id),
    (SELECT concat_ws(' ', device_make, device_model)
       FROM public.assets
      WHERE id = _asset_id),
    (SELECT filename FROM public.assets WHERE id = _asset_id),
    (SELECT parent_folder_path FROM public.assets WHERE id = _asset_id)
  ) INTO _content;

  INSERT INTO public.asset_search_documents(asset_id, user_id, content, search_tsv)
  VALUES (_asset_id, _uid, COALESCE(_content, ''), to_tsvector('english', COALESCE(_content, '')))
  ON CONFLICT (asset_id) DO UPDATE
    SET content = EXCLUDED.content,
        search_tsv = EXCLUDED.search_tsv,
        updated_at = now();
END;
$$;
