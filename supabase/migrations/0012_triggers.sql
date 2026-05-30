-- 0012_triggers.sql -- Search-document maintenance triggers

create or replace function public.rebuild_search_doc(_asset_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare _content text; _uid uuid;
begin
  select user_id into _uid from public.assets where id = _asset_id;
  if _uid is null then return; end if;

  select concat_ws(' ',
      (select string_agg(caption,' ') from public.asset_captions where asset_id = _asset_id),
      (select text from public.asset_ocr where asset_id = _asset_id),
      (select string_agg(label,' ') from public.asset_labels where asset_id = _asset_id),
      (select string_agg(al.name,' ')
         from public.asset_album_memberships am
         join public.asset_albums al on al.id = am.album_id
        where am.asset_id = _asset_id),
      (select concat_ws(' ', city, country, region) from public.asset_locations where asset_id = _asset_id),
      (select concat_ws(' ', device_make, device_model) from public.assets where id = _asset_id)
  ) into _content;

  insert into public.asset_search_documents(asset_id, user_id, content, search_tsv)
    values (_asset_id, _uid, coalesce(_content,''), to_tsvector('english', coalesce(_content,'')))
  on conflict (asset_id) do update
    set content = excluded.content,
        search_tsv = excluded.search_tsv,
        updated_at = now();
end;
$$;

create or replace function public.tg_rebuild_search_doc()
returns trigger language plpgsql as $$
declare _aid uuid;
begin
  _aid := coalesce(new.asset_id, old.asset_id);
  if _aid is not null then perform public.rebuild_search_doc(_aid); end if;
  return null;
end;
$$;

create trigger trg_search_doc_captions
  after insert or update or delete on public.asset_captions
  for each row execute function public.tg_rebuild_search_doc();
create trigger trg_search_doc_ocr
  after insert or update or delete on public.asset_ocr
  for each row execute function public.tg_rebuild_search_doc();
create trigger trg_search_doc_labels
  after insert or update or delete on public.asset_labels
  for each row execute function public.tg_rebuild_search_doc();
create trigger trg_search_doc_albums
  after insert or update or delete on public.asset_album_memberships
  for each row execute function public.tg_rebuild_search_doc();
create trigger trg_search_doc_locations
  after insert or update or delete on public.asset_locations
  for each row execute function public.tg_rebuild_search_doc();
