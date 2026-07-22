-- Liana accounts: Liana moves from capability-token auth to real sign-in (Firebase, same
-- project as jungle). An "account" is a participant with a firebase_uid; chat surfaces prompt
-- unaccounted users to create one instead of silently minting shadow participants.

-- Single-use codes binding a Slack identity to whoever completes Google sign-in on the web.
-- Minted when an unaccounted Slack user messages Liana ("Create your account" button); redeemed
-- by POST /api/liana/link/slack with a Firebase token.
create table if not exists liana_link_codes (
  code          text primary key,
  team_id       text not null references liana_slack_installs(team_id) on delete cascade,
  slack_user_id text not null,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);

-- Accounts can exist without a Slack install (sign up on the web, chat over iMessage/Telegram
-- only), so a Liana workflow's Slack ownership context becomes optional. Ownership is the
-- participant; team/slack ids remain as the Slack delivery + origin context when present.
alter table liana_workflows
  alter column team_id drop not null,
  alter column slack_user_id drop not null;
create index if not exists liana_workflows_participant_idx on liana_workflows (owner_participant_id);
