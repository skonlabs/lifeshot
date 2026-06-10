-- Retire legacy derived-media cache tables (asset_thumbnails, asset_proxies).
-- Live preview path uses asset_derivatives + asset_preview_metadata. Writers
-- removed from generateDerived.ts and privacy/index.ts in the same change.

drop table if exists public.asset_thumbnails cascade;
drop table if exists public.asset_proxies cascade;
