-- 20260601020000_enrichment_timestamps.sql
-- Adds tracking timestamps to OCR and AI enrichment tables.
-- ocrAsset and enrichAI jobs now write these columns.

alter table public.asset_ocr
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists ocr_at timestamptz;

alter table public.asset_ai_enrichment
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists enriched_at timestamptz;

-- Index for querying un-enriched vs enriched assets efficiently.
create index if not exists idx_ai_enrichment_at
  on public.asset_ai_enrichment(enriched_at) where enriched_at is not null;

create index if not exists idx_ocr_at
  on public.asset_ocr(ocr_at) where ocr_at is not null;
