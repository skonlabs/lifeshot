-- 0001_extensions_and_enums.sql
-- Enable required extensions, shared enums, and updated_at trigger function.
-- Rollback: drop functions, then enums, then extensions in reverse order.

create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists btree_gin;

-- Shared updated_at trigger
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Enums
do $$ begin
  create type media_type as enum ('photo','video','live_photo','animation','document','audio','unknown');
exception when duplicate_object then null; end $$;

do $$ begin
  create type visibility_state as enum ('private','family','public');
exception when duplicate_object then null; end $$;

do $$ begin
  create type deleted_state as enum ('active','soft_deleted','purged');
exception when duplicate_object then null; end $$;

do $$ begin
  create type permission_state as enum ('owner','shared_read','shared_write','restricted');
exception when duplicate_object then null; end $$;

do $$ begin
  create type sync_status as enum ('pending','connecting','active','paused','error','disconnected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type source_kind as enum (
    'google_photos','icloud','local_ios','local_android','desktop_folder',
    'export_import','dropbox','onedrive','nas','external_drive','amazon_photos'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type family_role as enum ('owner','admin','member','child','guest');
exception when duplicate_object then null; end $$;

do $$ begin
  create type consent_scope as enum (
    'ai_processing','face_recognition','thumbnail_caching','proxy_caching',
    'location_processing','family_sharing','export'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type edge_type as enum (
    'asset_in_event','asset_at_place','asset_of_person','asset_duplicate_of_asset',
    'person_at_event','person_at_place','event_at_place','asset_in_collection',
    'asset_in_album','person_related_to_person'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type node_type as enum ('asset','person','place','event','collection','album');
exception when duplicate_object then null; end $$;

do $$ begin
  create type dup_match_type as enum ('checksum','perceptual','video_fingerprint','near_duplicate','user_marked');
exception when duplicate_object then null; end $$;
