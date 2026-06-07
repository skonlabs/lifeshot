-- Conservative schema cleanup: drop columns with zero read/write references
-- in supabase/functions/** and src/**. Each column below has been superseded
-- by a newer column or by a dedicated table (see audit notes inline).

-- 1) asset_exif.gps (jsonb): superseded by the asset_gps table.
--    No code writes or reads asset_exif.gps after the metadata engine migration.
ALTER TABLE public.asset_exif DROP COLUMN IF EXISTS gps;

-- 2) asset_exif.exposure_program: superseded by asset_exif.exposure_mode.
--    No code reference in functions/ or src/.
ALTER TABLE public.asset_exif DROP COLUMN IF EXISTS exposure_program;

-- 3) asset_exif.lens: superseded by asset_exif.lens_model / lens_make.
--    indexSearchDocument selects lens_model; lens is never SELECTed.
ALTER TABLE public.asset_exif DROP COLUMN IF EXISTS lens;

-- 4) asset_source_refs.last_seen_at: superseded by source_last_seen_at.
--    Every code reference uses source_last_seen_at; bare last_seen_at is unused.
ALTER TABLE public.asset_source_refs DROP COLUMN IF EXISTS last_seen_at;
