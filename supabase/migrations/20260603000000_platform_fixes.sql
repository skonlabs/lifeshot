-- ============================================================================
-- 20260603000000_platform_fixes
-- Platform fixes: faces enrichment, people/places clustering support.
-- ============================================================================

-- ── asset_ai_enrichment: store detected faces alongside caption/tags/objects ─
alter table public.asset_ai_enrichment
  add column if not exists faces jsonb not null default '[]'::jsonb;

comment on column public.asset_ai_enrichment.faces is
  'Detected faces: array of { bbox, score }. Populated by enrichAI when faces are detected.';

-- ── person_faces: track unique-per-(person,asset) so re-runs are idempotent ──
-- clusterPeople upserts on (person_id, asset_id); ensure that constraint exists.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'person_faces_person_asset_uniq'
  ) then
    alter table public.person_faces
      add constraint person_faces_person_asset_uniq unique (person_id, asset_id);
  end if;
end $$;

-- ── asset_locations: clusterPlaces upserts location rows keyed by asset_id ────
-- asset_id is already unique (see 0004_asset_catalog.sql); add place linkage
-- so a location can be tied to a named place row.
alter table public.asset_locations
  add column if not exists place_id uuid references public.places(id) on delete set null;

create index if not exists idx_asset_locations_place on public.asset_locations(place_id);

-- ── people: allow linking an auto-created cluster back to a source label ──────
alter table public.people
  add column if not exists auto_label text;

comment on column public.people.auto_label is
  'Stable label used by clusterPeople to dedupe auto-created person rows on re-run.';

-- Unique per-user auto_label so clusterPeople can upsert deterministically.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'people_user_auto_label_uniq'
  ) then
    alter table public.people
      add constraint people_user_auto_label_uniq unique (user_id, auto_label);
  end if;
end $$;

-- ── places: dedupe auto-created place rows on re-run by (user_id, name) ───────
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'places_user_name_uniq'
  ) then
    alter table public.places
      add constraint places_user_name_uniq unique (user_id, name);
  end if;
end $$;
