-- 20260611100000_schema_cleanup.sql
--
-- Full schema cleanup after codebase audit:
--   1. Drop tables that no code reads or writes.
--   2. Drop RPC functions never called from any edge function or frontend.
--   3. Drop columns that are unused or duplicate data held elsewhere.
--   4. Replace the never-populated timeline_windows materialization with a
--      live aggregation RPC (timeline_buckets) used by catalog /timeline.

-- ── 1. Unused tables ──────────────────────────────────────────────────────────
-- face_clusters: created for unsupervised clustering; never populated or read.
DROP TABLE IF EXISTS public.face_clusters CASCADE;
-- asset_search_index: superseded by assets.search_tsv; never written.
DROP TABLE IF EXISTS public.asset_search_index CASCADE;
-- asset_ai_ready_metadata: readiness is derived live from privacy_settings;
-- nothing writes this table.
DROP TABLE IF EXISTS public.asset_ai_ready_metadata CASCADE;
-- person_faces: replaced by people.faces JSONB (idempotent re-drop).
DROP TABLE IF EXISTS public.person_faces CASCADE;
-- timeline_windows: the materializer job was never enqueued so this table was
-- always empty. catalog /timeline now aggregates live via timeline_buckets().
DROP TABLE IF EXISTS public.timeline_windows CASCADE;

-- ── 2. Unused RPC functions ───────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_viewport(text, int, jsonb);
DROP FUNCTION IF EXISTS public.get_dashboard_counts();
DROP FUNCTION IF EXISTS public.merge_assets(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.split_source_ref(uuid, text);
DROP FUNCTION IF EXISTS public.disconnect_source(uuid);
DROP FUNCTION IF EXISTS public.force_sync_source(uuid);
DROP FUNCTION IF EXISTS public.check_rate_limit(text, int, int);
DROP FUNCTION IF EXISTS public.cache_set(text, jsonb, int);
DROP FUNCTION IF EXISTS public.cache_get(text);
DROP FUNCTION IF EXISTS public.refresh_timeline_windows(uuid);
DROP FUNCTION IF EXISTS public.get_timeline_window(text, text);

-- ── 3. Unused / duplicate columns ─────────────────────────────────────────────
-- assets: columns added speculatively and never read by any code path.
ALTER TABLE public.assets
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS local_time,
  DROP COLUMN IF EXISTS place_name,
  DROP COLUMN IF EXISTS place_id_text;

-- user_profiles: consent lives in privacy_settings (ai_enabled /
-- face_processing_enabled); status/deleted_at were only written by the
-- removed deleteAccount job. delete_account RPC handles account removal.
ALTER TABLE public.user_profiles
  DROP COLUMN IF EXISTS ai_processing_enabled,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS deleted_at;

-- rekognition_response is authoritative ONLY in asset_ai_enrichment.
-- The copies added to the per-media metadata tables were never written.
ALTER TABLE public.asset_media_metadata    DROP COLUMN IF EXISTS rekognition_response;
ALTER TABLE public.asset_video_metadata    DROP COLUMN IF EXISTS rekognition_response;
ALTER TABLE public.asset_document_metadata DROP COLUMN IF EXISTS rekognition_response;
ALTER TABLE public.asset_audio_metadata    DROP COLUMN IF EXISTS rekognition_response;

-- ── 4. Live timeline aggregation RPC ─────────────────────────────────────────
-- Replaces the timeline_windows materialized table. Buckets the caller's
-- assets by capture_time at the requested granularity and returns the most
-- recent 120 buckets, each with a cover asset id.
CREATE OR REPLACE FUNCTION public.timeline_buckets(_granularity text)
RETURNS TABLE (
  bucket      text,
  asset_count bigint,
  start_time  timestamptz,
  end_time    timestamptz,
  asset_ids   uuid[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    to_char(date_trunc(
      CASE WHEN _granularity IN ('day','month','year') THEN _granularity ELSE 'month' END,
      a.capture_time), 'YYYY-MM-DD')           AS bucket,
    count(*)                                    AS asset_count,
    min(a.capture_time)                         AS start_time,
    max(a.capture_time)                         AS end_time,
    (array_agg(a.id ORDER BY a.capture_time DESC))[1:1] AS asset_ids
  FROM public.assets a
  WHERE a.user_id = auth.uid()
    AND a.capture_time IS NOT NULL
    AND COALESCE(a.deleted_state, 'active') = 'active'
  GROUP BY 1
  ORDER BY 1 DESC
  LIMIT 120;
$$;

GRANT EXECUTE ON FUNCTION public.timeline_buckets(text) TO authenticated;
