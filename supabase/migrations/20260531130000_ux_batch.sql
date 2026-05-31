-- Onboarding step tracking + bulk asset op support
alter table public.user_profiles
  add column if not exists onboarding_state jsonb not null default '{}'::jsonb;

-- Allow organization function to bulk-soft-delete assets via authenticated client (RLS already restricts to owner).
-- No schema change to assets required; assets.deleted_state already exists.
