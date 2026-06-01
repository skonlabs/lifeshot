-- 20260601030000_search_doc_triggers.sql
-- 1. Auto-compute search_tsv when content is written to asset_search_documents.
--    indexSearchDocument writes content directly; this trigger ensures the
--    tsvector is always in sync without requiring callers to compute it.
-- 2. Add trigger on asset_ai_enrichment so AI caption/tags propagate to
--    search documents via the existing rebuild_search_doc path.

-- ── Trigger: recompute search_tsv on asset_search_documents upsert ───────────
create or replace function public.tg_search_doc_tsv()
returns trigger language plpgsql as $$
begin
  new.search_tsv := to_tsvector('english', coalesce(new.content, ''));
  return new;
end;
$$;

drop trigger if exists trg_search_doc_tsv on public.asset_search_documents;
create trigger trg_search_doc_tsv
  before insert or update of content
  on public.asset_search_documents
  for each row execute function public.tg_search_doc_tsv();

-- ── Trigger: propagate AI enrichment changes into search documents ────────────
-- When a caption/tags row is written to asset_ai_enrichment, update the
-- asset_search_documents content so hybrid_search reflects the new data.
-- We call rebuild_search_doc which re-queries all enrichment tables.
create or replace function public.tg_ai_enrichment_to_search_doc()
returns trigger language plpgsql as $$
declare _aid uuid;
begin
  _aid := coalesce(new.asset_id, old.asset_id);
  if _aid is not null then
    -- Extend rebuild_search_doc to include AI enrichment fields.
    perform public.rebuild_search_doc_with_ai(_aid);
  end if;
  return null;
end;
$$;

-- Extended rebuild that also reads asset_ai_enrichment.
create or replace function public.rebuild_search_doc_with_ai(_asset_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare _content text; _uid uuid;
begin
  select user_id into _uid from public.assets where id = _asset_id;
  if _uid is null then return; end if;

  select concat_ws(' ',
    (select caption from public.asset_ai_enrichment where asset_id = _asset_id),
    (select array_to_string(tags, ' ') from public.asset_ai_enrichment where asset_id = _asset_id),
    (select string_agg(label,' ') from public.asset_labels where asset_id = _asset_id),
    (select string_agg(caption,' ') from public.asset_captions where asset_id = _asset_id),
    (select text from public.asset_ocr where asset_id = _asset_id),
    (select string_agg(al.name,' ')
       from public.asset_album_memberships am
       join public.asset_albums al on al.id = am.album_id
      where am.asset_id = _asset_id),
    (select concat_ws(', ',
              reverse_geocoded_city, reverse_geocoded_state,
              reverse_geocoded_country, place_name)
       from public.asset_gps where asset_id = _asset_id),
    (select concat_ws(' ', device_make, device_model) from public.assets where id = _asset_id)
  ) into _content;

  insert into public.asset_search_documents(asset_id, user_id, content, search_tsv)
    values (_asset_id, _uid, coalesce(_content,''), to_tsvector('english', coalesce(_content,'')))
  on conflict (asset_id) do update
    set content    = excluded.content,
        search_tsv = excluded.search_tsv,
        updated_at = now();
end;
$$;

drop trigger if exists trg_search_doc_ai on public.asset_ai_enrichment;
create trigger trg_search_doc_ai
  after insert or update or delete on public.asset_ai_enrichment
  for each row execute function public.tg_ai_enrichment_to_search_doc();

-- Also trigger on asset_gps for location changes (asset_locations is legacy).
drop trigger if exists trg_search_doc_gps on public.asset_gps;
create trigger trg_search_doc_gps
  after insert or update or delete on public.asset_gps
  for each row execute function public.tg_rebuild_search_doc();
