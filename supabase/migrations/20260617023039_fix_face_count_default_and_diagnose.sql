-- Ensure face_count has no DEFAULT 0 so bootstrap upserts create NULL rows,
-- not rows that look like "scanned, no faces found".
-- (Idempotent — safe to run even if 20260616044240 already applied this.)
alter table public.asset_ai_enrichment
  alter column face_count drop default;

alter table public.asset_ai_enrichment
  alter column face_count drop not null;

-- Reset any face_count=0 rows that were created by the DEFAULT 0 bootstrap
-- (face_scanned_at IS NULL means Rekognition never actually ran for them).
update public.asset_ai_enrichment e
   set face_count = null
  from public.assets a
 where e.asset_id = a.id
   and e.face_count = 0
   and a.face_scanned_at is null
   and a.media_type in ('photo', 'live_photo', 'animation');

-- Diagnostic: show what the affected assets look like so the root cause
-- (null keys, wrong media_type, missing storage files) is visible.
select
  a.id                          as asset_id,
  a.media_type,
  a.mime_type,
  a.face_scanned_at,
  e.face_count,
  case
    when a.thumbnail_cache_key is null then 'NULL'
    when a.thumbnail_cache_key ~ '^https?://' then 'http_url'
    else 'storage_path'
  end                           as thumb_key_type,
  case
    when a.proxy_cache_key is null then 'NULL'
    when a.proxy_cache_key ~ '^https?://' then 'http_url'
    else 'storage_path'
  end                           as proxy_key_type,
  mm.thumbnail_storage_path is not null as has_thumb_storage,
  mm.preview_storage_path   is not null as has_preview_storage,
  asr.source_kind
from public.assets a
join public.asset_ai_enrichment e on e.asset_id = a.id
left join public.asset_media_metadata mm on mm.asset_id = a.id
left join public.asset_source_refs asr
       on asr.asset_id = a.id and asr.is_primary = true
where a.media_type in ('photo', 'live_photo', 'animation')
  and (e.face_count = 0 or e.face_count is null)
order by asr.source_kind, a.media_type
limit 20;
