-- 0002_core_identity.sql -- Identity, families, consent, privacy

create table public.user_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  locale text default 'en',
  timezone text default 'UTC',
  tier text default 'free',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.user_profiles is 'Per-user profile and tier info, mirrors auth.users.';
create trigger trg_user_profiles_updated before update on public.user_profiles for each row execute function public.set_updated_at();

create table public.families (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.families is 'Family group container for opt-in sharing.';
create index idx_families_owner on public.families(owner_user_id);
create trigger trg_families_updated before update on public.families for each row execute function public.set_updated_at();

create table public.family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role family_role not null default 'member',
  status text not null default 'active',
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(family_id, user_id)
);
comment on table public.family_members is 'Membership records that gate family sharing.';
create index idx_family_members_user on public.family_members(user_id);
create index idx_family_members_family on public.family_members(family_id);
create trigger trg_family_members_updated before update on public.family_members for each row execute function public.set_updated_at();

create table public.family_invitations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  email text not null,
  token text not null unique,
  role family_role not null default 'member',
  status text not null default 'pending',
  expires_at timestamptz not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.family_invitations is 'Pending invitations to join a family.';
create index idx_family_invitations_family on public.family_invitations(family_id);
create trigger trg_family_invitations_updated before update on public.family_invitations for each row execute function public.set_updated_at();

create table public.consent_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scope consent_scope not null,
  source_account_id uuid null,
  granted boolean not null,
  granted_at timestamptz,
  revoked_at timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.consent_records is 'Append-style consent log per user per scope.';
create index idx_consent_user_scope on public.consent_records(user_id, scope);
create trigger trg_consent_updated before update on public.consent_records for each row execute function public.set_updated_at();

create table public.privacy_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  ai_enabled boolean not null default false,
  face_processing_enabled boolean not null default false,
  default_visibility visibility_state not null default 'private',
  per_source_overrides jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.privacy_settings is 'Per-user privacy controls (consent-gated AI processing).';
create trigger trg_privacy_settings_updated before update on public.privacy_settings for each row execute function public.set_updated_at();

-- Family membership helper (SECURITY DEFINER prevents recursive RLS)
create or replace function public.is_family_member(_family_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.family_members
    where family_id = _family_id and user_id = auth.uid() and status = 'active'
  );
$$;
