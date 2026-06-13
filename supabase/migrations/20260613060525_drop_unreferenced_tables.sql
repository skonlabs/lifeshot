-- Drop tables that have no references anywhere in src/ or supabase/functions/.
-- 26 of these were already dropped in earlier cleanup migrations; the IF EXISTS
-- re-drops are idempotent. `source_rate_buckets` is the only one still live.

-- Still-live (token-bucket rate limit; superseded by in-memory limiter in worker).
drop table if exists public.source_rate_buckets cascade;

-- Legacy wide-split asset metadata (merged into asset_ai_enrichment / asset_exif / asset_file_metadata).
drop table if exists public.asset_metadata          cascade;
drop table if exists public.asset_captions          cascade;
drop table if exists public.asset_labels            cascade;
drop table if exists public.asset_sensitive_flags   cascade;
drop table if exists public.asset_blurhashes        cascade;
drop table if exists public.asset_quality_scores    cascade;
drop table if exists public.asset_visibility        cascade;
drop table if exists public.asset_devices           cascade;

-- Legacy derivative / cache tables (replaced by asset_derivatives + storage caching).
drop table if exists public.asset_thumbnails        cascade;
drop table if exists public.asset_proxies           cascade;
drop table if exists public.asset_cache_status      cascade;
drop table if exists public.asset_search_index      cascade;
drop table if exists public.asset_dedup_groups      cascade;

-- First-gen albums / collections (replaced by events + people).
drop table if exists public.asset_album_memberships cascade;
drop table if exists public.asset_albums            cascade;
drop table if exists public.collection_assets       cascade;
drop table if exists public.smart_collections       cascade;

-- Abandoned knowledge-graph experiment.
drop table if exists public.memory_edges            cascade;
drop table if exists public.memory_nodes            cascade;
drop table if exists public.graph_snapshots         cascade;

-- Old scan / ingest pipeline (replaced by scan_sessions + scan_batches + job_queue).
drop table if exists public.scan_roots              cascade;
drop table if exists public.ingestion_events        cascade;

-- Misc telemetry / config (replaced by structured logs + env-based config).
drop table if exists public.user_activity_events    cascade;
drop table if exists public.performance_metrics     cascade;
drop table if exists public.system_config           cascade;
drop table if exists public.places_summary          cascade;
