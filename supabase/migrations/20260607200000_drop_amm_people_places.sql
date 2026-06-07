-- People & places already live in their own tables (public.people,
-- public.places + assets.place_id). The JSONB mirror columns on
-- asset_media_metadata were redundant — drop them.
alter table public.asset_media_metadata drop column if exists people;
alter table public.asset_media_metadata drop column if exists places;

notify pgrst, 'reload schema';
