-- people_list_for_user: returns one row per person with a TRIMMED faces array.
-- Strips heavy face_vector embeddings, full rekognition_response, and face_crop
-- base64 blobs; keeps asset_id, bbox, confidence, and Pose/Quality attrs needed
-- for avatar scoring in the /people endpoint.
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
