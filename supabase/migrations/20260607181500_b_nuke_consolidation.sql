-- B-NUKE consolidation
BEGIN;

ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS filename text,
  ADD COLUMN IF NOT EXISTS relative_path text,
  ADD COLUMN IF NOT EXISTS parent_folder_path text,
  ADD COLUMN IF NOT EXISTS folder_tokens text[],
  ADD COLUMN IF NOT EXISTS filename_tokens text[],
  ADD COLUMN IF NOT EXISTS search_content text,
  ADD COLUMN IF NOT EXISTS search_tsv tsvector;

CREATE INDEX IF NOT EXISTS assets_search_tsv_idx ON public.assets USING gin(search_tsv);
CREATE INDEX IF NOT EXISTS assets_checksum_hash_idx ON public.assets(checksum_hash);
CREATE INDEX IF NOT EXISTS assets_perceptual_hash_idx ON public.assets(perceptual_hash);

ALTER TABLE public.asset_ai_enrichment
  ADD COLUMN IF NOT EXISTS ocr_text text,
  ADD COLUMN IF NOT EXISTS ocr_lang text,
  ADD COLUMN IF NOT EXISTS ocr_confidence numeric,
  ADD COLUMN IF NOT EXISTS ocr_boxes jsonb,
  ADD COLUMN IF NOT EXISTS ocr_at timestamptz;

ALTER TABLE public.asset_media_metadata
  ADD COLUMN IF NOT EXISTS blurhash text,
  ADD COLUMN IF NOT EXISTS dominant_color text,
  ADD COLUMN IF NOT EXISTS palette jsonb,
  ADD COLUMN IF NOT EXISTS thumbnail_url text,
  ADD COLUMN IF NOT EXISTS thumbnail_storage_path text,
  ADD COLUMN IF NOT EXISTS preview_url text,
  ADD COLUMN IF NOT EXISTS preview_storage_path text,
  ADD COLUMN IF NOT EXISTS poster_url text,
  ADD COLUMN IF NOT EXISTS poster_storage_path text,
  ADD COLUMN IF NOT EXISTS web_url text,
  ADD COLUMN IF NOT EXISTS web_storage_path text,
  ADD COLUMN IF NOT EXISTS derivatives jsonb,
  ADD COLUMN IF NOT EXISTS rekognition_response jsonb;

ALTER TABLE public.asset_video_metadata
  ADD COLUMN IF NOT EXISTS thumbnail_url text,
  ADD COLUMN IF NOT EXISTS poster_url text,
  ADD COLUMN IF NOT EXISTS rekognition_response jsonb;

ALTER TABLE public.asset_audio_metadata
  ADD COLUMN IF NOT EXISTS thumbnail_url text,
  ADD COLUMN IF NOT EXISTS rekognition_response jsonb;

ALTER TABLE public.asset_document_metadata
  ADD COLUMN IF NOT EXISTS thumbnail_url text,
  ADD COLUMN IF NOT EXISTS preview_url text,
  ADD COLUMN IF NOT EXISTS rekognition_response jsonb;

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS faces jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS face_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rekognition_face_ids text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS cover_asset_id uuid REFERENCES public.assets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cover_bbox jsonb;

CREATE INDEX IF NOT EXISTS people_rekog_face_ids_idx ON public.people USING gin(rekognition_face_ids);

-- Backfills
UPDATE public.assets a SET
  filename = COALESCE(a.filename, f.filename),
  relative_path = COALESCE(a.relative_path, f.relative_path),
  parent_folder_path = COALESCE(a.parent_folder_path, f.parent_folder_path)
FROM public.asset_file_metadata f WHERE f.asset_id = a.id;

UPDATE public.assets a SET
  folder_tokens = COALESCE(a.folder_tokens, s.folder_tokens),
  filename_tokens = COALESCE(a.filename_tokens, s.filename_tokens)
FROM public.asset_organization_signals s WHERE s.asset_id = a.id;

UPDATE public.assets a SET
  search_content = sd.content, search_tsv = sd.search_tsv
FROM public.asset_search_documents sd WHERE sd.asset_id = a.id;

UPDATE public.assets a SET
  checksum_hash = COALESCE(a.checksum_hash, h.file_hash_sha256),
  perceptual_hash = COALESCE(a.perceptual_hash, h.perceptual_hash_image),
  video_fingerprint = COALESCE(a.video_fingerprint, h.video_fingerprint)
FROM public.asset_hashes h WHERE h.asset_id = a.id;

UPDATE public.asset_ai_enrichment e SET
  ocr_text = o.text, ocr_lang = o.lang,
  ocr_confidence = o.confidence, ocr_boxes = o.boxes, ocr_at = o.ocr_at
FROM public.asset_ocr o WHERE o.asset_id = e.asset_id;

INSERT INTO public.asset_ai_enrichment (asset_id, user_id, ocr_text, ocr_lang, ocr_confidence, ocr_boxes, ocr_at)
SELECT o.asset_id, o.user_id, o.text, o.lang, o.confidence, o.boxes, o.ocr_at
FROM public.asset_ocr o
WHERE NOT EXISTS (SELECT 1 FROM public.asset_ai_enrichment e WHERE e.asset_id = o.asset_id)
ON CONFLICT (asset_id) DO NOTHING;

UPDATE public.asset_media_metadata m SET
  blurhash = COALESCE(m.blurhash, p.blurhash),
  dominant_color = COALESCE(m.dominant_color, p.dominant_color),
  palette = COALESCE(m.palette, p.palette),
  thumbnail_storage_path = COALESCE(m.thumbnail_storage_path,
    CASE WHEN p.thumbnail_cache_key !~ '^https?://' THEN p.thumbnail_cache_key END),
  thumbnail_url = COALESCE(m.thumbnail_url,
    CASE WHEN p.thumbnail_cache_key ~ '^https?://' THEN p.thumbnail_cache_key END),
  preview_storage_path = COALESCE(m.preview_storage_path,
    CASE WHEN p.preview_cache_key !~ '^https?://' THEN p.preview_cache_key END),
  preview_url = COALESCE(m.preview_url,
    CASE WHEN p.preview_cache_key ~ '^https?://' THEN p.preview_cache_key END)
FROM public.asset_preview_metadata p WHERE p.asset_id = m.asset_id;

UPDATE public.asset_media_metadata m SET derivatives = sub.d
FROM (
  SELECT asset_id, jsonb_agg(jsonb_build_object(
    'kind', kind, 'storage_bucket', storage_bucket,
    'storage_path', storage_path, 'mime_type', mime_type, 'blurhash', blurhash)) d
  FROM public.asset_derivatives GROUP BY asset_id
) sub WHERE sub.asset_id = m.asset_id;

UPDATE public.people p SET
  faces = sub.faces, face_count = sub.cnt,
  rekognition_face_ids = sub.face_ids,
  cover_asset_id = sub.cover_asset, cover_bbox = sub.cover_bbox
FROM (
  SELECT person_id,
    jsonb_agg(jsonb_build_object(
      'asset_id', asset_id, 'bbox', bbox, 'confidence', confidence,
      'face_crop', face_crop, 'face_vector', face_vector,
      'rekognition_face_id', rekognition_face_id,
      'rekognition_response', rekognition_response,
      'created_at', created_at
    ) ORDER BY confidence DESC NULLS LAST)::jsonb AS faces,
    COUNT(*)::int AS cnt,
    COALESCE(array_remove(array_agg(rekognition_face_id ORDER BY confidence DESC NULLS LAST), NULL), '{}')::text[] AS face_ids,
    (array_agg(asset_id ORDER BY confidence DESC NULLS LAST))[1] AS cover_asset,
    (array_agg(bbox ORDER BY confidence DESC NULLS LAST))[1] AS cover_bbox
  FROM public.person_faces GROUP BY person_id
) sub WHERE sub.person_id = p.id;

-- FTS trigger on assets
CREATE OR REPLACE FUNCTION public.tg_assets_search_tsv() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv := to_tsvector('english', coalesce(NEW.search_content, ''));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_assets_search_tsv ON public.assets;
CREATE TRIGGER trg_assets_search_tsv
  BEFORE INSERT OR UPDATE OF search_content ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.tg_assets_search_tsv();

-- Rewrite hybrid_search to read from assets.search_tsv
CREATE OR REPLACE FUNCTION public.hybrid_search(
  _query_text text, _query_vector vector DEFAULT NULL,
  _filters jsonb DEFAULT '{}'::jsonb, _k integer DEFAULT 50)
RETURNS TABLE(asset_id uuid, score numeric, explanation jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $func$
#variable_conflict use_column
DECLARE
  _uid uuid := auth.uid();
  _from timestamptz; _to timestamptz; _media_type text;
BEGIN
  _from := nullif(_filters->>'from','')::timestamptz;
  _to   := nullif(_filters->>'to','')::timestamptz;
  _media_type := nullif(_filters->>'media_type','');
  RETURN QUERY
  WITH fts AS (
    SELECT a.id AS a_id,
      ts_rank_cd(a.search_tsv, plainto_tsquery('english', _query_text)) AS rank
    FROM public.assets a
    WHERE a.user_id = _uid AND a.deleted_state = 'active'
      AND (_query_text IS NULL OR a.search_tsv @@ plainto_tsquery('english', _query_text))
      AND (_from IS NULL OR a.capture_time >= _from)
      AND (_to IS NULL OR a.capture_time <= _to)
      AND (_media_type IS NULL OR a.media_type = _media_type)
      AND (
        _filters->'sources' IS NULL OR _filters->>'sources' = 'null' OR
        EXISTS (SELECT 1 FROM public.asset_source_refs asr
                WHERE asr.asset_id = a.id
                  AND asr.source_kind = ANY(array(select jsonb_array_elements_text(_filters->'sources'))))
      )
    ORDER BY rank DESC LIMIT greatest(_k*4, 200)
  ),
  fts_ranked AS (SELECT a_id, row_number() OVER (ORDER BY rank DESC) AS rk FROM fts),
  vec AS (
    SELECT * FROM (
      SELECT m.asset_id AS a_id, m.distance,
        row_number() OVER (ORDER BY m.distance ASC) AS rk
      FROM public.match_assets_by_embedding(_query_vector, greatest(_k*4,200), _from, _to) m
      WHERE _query_vector IS NOT NULL
    ) v
  ),
  union_set AS (
    SELECT a_id, 1.0/(60+rk) AS s FROM fts_ranked
    UNION ALL SELECT a_id, 1.0/(60+rk) AS s FROM vec
  ),
  fused AS (SELECT a_id, SUM(s) AS score FROM union_set GROUP BY a_id),
  dedup AS (
    SELECT f.a_id, f.score, a.duplicate_group_id,
      row_number() OVER (PARTITION BY coalesce(a.duplicate_group_id::text, f.a_id::text)
                         ORDER BY f.score DESC) rn
    FROM fused f JOIN public.assets a ON a.id = f.a_id
  )
  SELECT a_id, score, jsonb_build_object('rank_dedup', rn) FROM dedup WHERE rn = 1
  ORDER BY score DESC LIMIT _k;
END $func$;

CREATE OR REPLACE FUNCTION public.cache_invalidate_user(_prefix text DEFAULT '')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN RETURN; END $$;

DROP TABLE IF EXISTS public.asset_xmp_iptc CASCADE;
DROP TABLE IF EXISTS public.asset_ocr CASCADE;
DROP TABLE IF EXISTS public.asset_ai_ready_metadata CASCADE;
DROP TABLE IF EXISTS public.asset_derivatives CASCADE;
DROP TABLE IF EXISTS public.asset_hashes CASCADE;
DROP TABLE IF EXISTS public.asset_organization_signals CASCADE;
DROP TABLE IF EXISTS public.asset_preview_metadata CASCADE;
DROP TABLE IF EXISTS public.asset_search_documents CASCADE;
DROP TABLE IF EXISTS public.asset_file_metadata CASCADE;
DROP TABLE IF EXISTS public.person_faces CASCADE;
DROP TABLE IF EXISTS public.scan_sessions CASCADE;
DROP TABLE IF EXISTS public.scan_batches CASCADE;
DROP TABLE IF EXISTS public.scan_errors CASCADE;
DROP TABLE IF EXISTS public.scan_checkpoints CASCADE;
DROP TABLE IF EXISTS public.user_corrections CASCADE;
DROP MATERIALIZED VIEW IF EXISTS public.mv_asset_year_month CASCADE;
DROP TABLE IF EXISTS public.ingest_uploads CASCADE;
DROP TABLE IF EXISTS public.duplicate_group_members CASCADE;
DROP TABLE IF EXISTS public.duplicate_groups CASCADE;
DROP TABLE IF EXISTS public.dead_letter_jobs CASCADE;
DROP TABLE IF EXISTS public.data_exports CASCADE;
DROP TABLE IF EXISTS public.api_cache_entries CASCADE;

DROP FUNCTION IF EXISTS public.tg_rebuild_search_doc() CASCADE;
DROP FUNCTION IF EXISTS public.tg_search_doc_tsv() CASCADE;

COMMIT;
