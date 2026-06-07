-- Add per-asset aggregate jsonb columns to asset_media_metadata so the UI can
-- read a single row without joining people / places / derivatives / faces.
alter table public.asset_media_metadata
  add column if not exists thumbnails  jsonb,
  add column if not exists people      jsonb,
  add column if not exists places      jsonb,
  add column if not exists recognition jsonb;

-- Backfill thumbnails from existing derivatives column.
update public.asset_media_metadata
   set thumbnails = derivatives
 where thumbnails is null and derivatives is not null;

-- Backfill recognition from the per-asset face rows already stored
-- inside people.faces (rekognition_response is the raw Rekognition payload).
update public.asset_media_metadata m
   set recognition = sub.r
  from (
    select (f->>'asset_id')::uuid as asset_id,
           jsonb_agg(f->'rekognition_response') filter (where f ? 'rekognition_response') as r
      from public.people p,
           lateral jsonb_array_elements(coalesce(p.faces,'[]'::jsonb)) f
     group by (f->>'asset_id')::uuid
  ) sub
 where sub.asset_id = m.asset_id
   and m.recognition is null;

-- Backfill people: list of {person_id, name, bbox, confidence} per asset.
update public.asset_media_metadata m
   set people = sub.p
  from (
    select (f->>'asset_id')::uuid as asset_id,
           jsonb_agg(jsonb_build_object(
             'person_id', p.id,
             'name', coalesce(p.display_name, p.auto_label),
             'bbox', f->'bbox',
             'confidence', f->'confidence'
           )) as p
      from public.people p,
           lateral jsonb_array_elements(coalesce(p.faces,'[]'::jsonb)) f
     group by (f->>'asset_id')::uuid
  ) sub
 where sub.asset_id = m.asset_id
   and m.people is null;

-- Backfill places from asset_gps + places.
update public.asset_media_metadata m
   set places = jsonb_build_object(
         'place_id', a.place_id,
         'place_name', a.place_name,
         'city', g.reverse_geocoded_city,
         'state', g.reverse_geocoded_state,
         'country', g.reverse_geocoded_country,
         'lat', g.gps_latitude,
         'lng', g.gps_longitude
       )
  from public.assets a
  left join public.asset_gps g on g.asset_id = a.id
 where m.asset_id = a.id
   and m.places is null
   and (a.place_id is not null or g.gps_latitude is not null);

notify pgrst, 'reload schema';
