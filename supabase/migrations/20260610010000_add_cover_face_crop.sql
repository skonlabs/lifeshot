-- Add cover_face_crop to people table: stores the base64 JPEG of the best
-- frontal face for this person. Used directly as the avatar image so the
-- People page never needs to CSS-crop a group photo thumbnail.
alter table public.people add column if not exists cover_face_crop text;

-- Update people_list_for_user to expose cover_face_crop.
drop function if exists public.people_list_for_user(uuid);
create or replace function public.people_list_for_user(_user_id uuid)
returns table (
  id uuid,
  display_name text,
  is_child boolean,
  is_elder boolean,
  consent_required boolean,
  auto_label text,
  face_count int,
  cover_asset_id uuid,
  cover_bbox jsonb,
  cover_face_crop text,
  faces jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id, p.display_name, p.is_child, p.is_elder, p.consent_required,
    p.auto_label, p.face_count, p.cover_asset_id, p.cover_bbox,
    p.cover_face_crop,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'asset_id',   f->>'asset_id',
          'bbox',       f->'bbox',
          'confidence', f->'confidence',
          'attributes', jsonb_build_object(
            'Pose',    coalesce(f->'rekognition_response'->'Pose',    f->'attributes'->'Pose'),
            'Quality', coalesce(f->'rekognition_response'->'Quality', f->'attributes'->'Quality')
          )
        )
      )
      from jsonb_array_elements(coalesce(p.faces, '[]'::jsonb)) as f
    ), '[]'::jsonb) as faces
  from public.people p
  where p.user_id = _user_id;
$$;

grant execute on function public.people_list_for_user(uuid) to authenticated, service_role;
