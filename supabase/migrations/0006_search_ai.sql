-- 0006_search_ai.sql -- Embeddings, OCR, labels, captions, search docs, query log
-- Default embedding model: text-embedding-3-small (DIM 1536). See OPEN DECISIONS.

create table public.asset_embeddings (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  model text not null default 'text-embedding-3-small',
  dim int not null default 1536,
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(asset_id, model)
);
comment on table public.asset_embeddings is 'Vector embeddings (default OpenAI text-embedding-3-small / 1536).';
-- HNSW cosine ANN index. Retune (m, ef_construction) past ~1M vectors.
create index idx_asset_embeddings_hnsw
  on public.asset_embeddings using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
create index idx_asset_embeddings_asset on public.asset_embeddings(asset_id);
create trigger trg_embeddings_updated before update on public.asset_embeddings for each row execute function public.set_updated_at();

create table public.asset_ocr (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  text text,
  lang text,
  confidence numeric,
  boxes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.asset_ocr is 'OCR text extracted from an asset.';
create index idx_ocr_text_trgm on public.asset_ocr using gin (text gin_trgm_ops) where text is not null;
create trigger trg_ocr_updated before update on public.asset_ocr for each row execute function public.set_updated_at();

create table public.asset_labels (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  label text not null,
  score numeric,
  source text not null default 'model',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(asset_id, label, source)
);
comment on table public.asset_labels is 'Multi-source labels (model/provider/user).';
create index idx_labels_asset on public.asset_labels(asset_id);
create index idx_labels_label on public.asset_labels(label);
create trigger trg_labels_updated before update on public.asset_labels for each row execute function public.set_updated_at();

create table public.asset_captions (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  caption text not null,
  model text not null,
  score numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(asset_id, model)
);
comment on table public.asset_captions is 'Per-model captions for an asset.';
create trigger trg_captions_updated before update on public.asset_captions for each row execute function public.set_updated_at();

create table public.asset_search_documents (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null default '',
  search_tsv tsvector,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.asset_search_documents is 'Per-asset full-text search document (caption+OCR+labels+album+place+device).';
create index idx_search_docs_tsv on public.asset_search_documents using gin (search_tsv);
create index idx_search_docs_content_trgm on public.asset_search_documents using gin (content gin_trgm_ops);
create index idx_search_docs_user on public.asset_search_documents(user_id);
create trigger trg_search_docs_updated before update on public.asset_search_documents for each row execute function public.set_updated_at();

create table public.search_queries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  raw_query text not null,
  parsed jsonb not null default '{}'::jsonb,
  result_count int,
  latency_ms int,
  reformulated_from uuid references public.search_queries(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.search_queries is 'User search log for analytics and learn-to-rank.';
create index idx_search_queries_user on public.search_queries(user_id, created_at desc);
create trigger trg_search_queries_updated before update on public.search_queries for each row execute function public.set_updated_at();

create table public.search_result_cache (
  id uuid primary key default gen_random_uuid(),
  cache_key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  payload jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, cache_key)
);
comment on table public.search_result_cache is 'Cached search results keyed per user.';
create index idx_search_cache_expiry on public.search_result_cache(expires_at);
create trigger trg_search_cache_updated before update on public.search_result_cache for each row execute function public.set_updated_at();
