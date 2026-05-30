-- 0005_derived_media.sql -- Thumbnails, proxies, blurhash, cache status

create table public.asset_thumbnails (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  size text not null,
  cache_key text not null,
  width int, height int,
  ready boolean not null default false,
  generated_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(asset_id, size)
);
comment on table public.asset_thumbnails is 'Thumbnail variants per asset (caching layer pointers).';
create index idx_thumb_asset on public.asset_thumbnails(asset_id);
create trigger trg_thumb_updated before update on public.asset_thumbnails for each row execute function public.set_updated_at();

create table public.asset_proxies (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  quality text not null,
  cache_key text not null,
  ready boolean not null default false,
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(asset_id, quality)
);
comment on table public.asset_proxies is 'Lower-resolution proxies used for fast playback / preview.';
create trigger trg_proxy_updated before update on public.asset_proxies for each row execute function public.set_updated_at();

create table public.asset_blurhashes (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  blurhash text not null,
  dominant_color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.asset_blurhashes is 'BlurHash placeholders for instant render.';
create trigger trg_blurhash_updated before update on public.asset_blurhashes for each row execute function public.set_updated_at();

create table public.asset_cache_status (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  layer text not null,
  status text not null,
  last_warmed_at timestamptz,
  ttl_seconds int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(asset_id, layer)
);
comment on table public.asset_cache_status is 'Cache warmth tracking per layer (CDN, edge, etc.).';
create trigger trg_cache_status_updated before update on public.asset_cache_status for each row execute function public.set_updated_at();
