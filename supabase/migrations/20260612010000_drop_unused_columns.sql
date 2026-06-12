-- 20260612010000_drop_unused_columns.sql
--
-- Drop columns that are confirmed unused across all edge functions and
-- frontend code. Each entry was individually verified against:
--   • supabase/functions/**/*.ts  (SELECT / .select() / .update() / .insert())
--   • src/**/*.ts{x}              (API hooks and direct column references)
--
-- No behavioural change — callers never read or write these fields.

-- ── assets ────────────────────────────────────────────────────────────────────
-- capture_time_confidence: never read or written by any code path.
ALTER TABLE public.assets DROP COLUMN IF EXISTS capture_time_confidence;

-- primary_source_ref_id: was intended as a denorm pointer; never set or read.
ALTER TABLE public.assets DROP COLUMN IF EXISTS primary_source_ref_id;

-- quality_score: speculative; no scorer ever writes it, no reader ever reads it.
ALTER TABLE public.assets DROP COLUMN IF EXISTS quality_score;

-- embedding_id / memory_node_id: placeholders for a vector-store layer that
-- was never built; no code references either column.
ALTER TABLE public.assets DROP COLUMN IF EXISTS embedding_id;
ALTER TABLE public.assets DROP COLUMN IF EXISTS memory_node_id;

-- visibility_state / permission_state: access-control enums that were
-- superseded by RLS policies; no app code reads or writes them.
ALTER TABLE public.assets DROP COLUMN IF EXISTS visibility_state;
ALTER TABLE public.assets DROP COLUMN IF EXISTS permission_state;

-- location_lat / location_lng / location_city / location_country:
-- The canonical location store is asset_gps (written by normalizeMetadata /
-- syncSource via asset_gps upsert). These denorm copies on assets are never
-- read by catalog, search, or any frontend query — location_confidence is
-- kept because persistence.ts writes it to asset_gps, not to assets directly.
ALTER TABLE public.assets DROP COLUMN IF EXISTS location_lat;
ALTER TABLE public.assets DROP COLUMN IF EXISTS location_lng;
ALTER TABLE public.assets DROP COLUMN IF EXISTS location_city;
ALTER TABLE public.assets DROP COLUMN IF EXISTS location_country;

-- ── people ────────────────────────────────────────────────────────────────────
-- family_id: family membership lives in the family_members junction table;
-- people.family_id is never read or written anywhere in the codebase.
ALTER TABLE public.people DROP COLUMN IF EXISTS family_id;
