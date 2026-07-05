-- 013_google_identities.sql — a participant's connected Google account (Gmail OAuth).
--
-- Per-user (not per-agent) OAuth identity, mirroring github_identities: one connected Google
-- account per participant, obtained via our Google OAuth flow with offline access (→ refresh
-- token). An agent's `gmail` integration references the connecting user by id
-- (agent_integrations.config.backingParticipantId) and mints Gmail access tokens from this row
-- at runtime — see backend/src/google.ts and backend/src/db/google.ts.
--
-- MVP: tokens stored plaintext on the box (same precedent as github_identities); encrypt at rest
-- before any real multi-tenant deployment.

create table if not exists google_identities (
  participant_id    uuid primary key references participants(id) on delete cascade,
  email             text not null,                    -- the connected Google account's address
  access_token      text not null,
  refresh_token     text,
  access_expires_at timestamptz,                       -- when access_token expires (~1h)
  scopes            text,                              -- space-delimited (informational)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
