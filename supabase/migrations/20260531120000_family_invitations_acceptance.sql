-- Add acceptance + email-tracking columns required by families function and sendInvitationEmail job.
alter table public.family_invitations
  add column if not exists accepted_at timestamptz,
  add column if not exists accepted_by uuid references auth.users(id) on delete set null,
  add column if not exists last_sent_at timestamptz,
  add column if not exists email_message_id text;

create index if not exists idx_family_invitations_token on public.family_invitations(token);
create index if not exists idx_family_invitations_accepted_by on public.family_invitations(accepted_by);
