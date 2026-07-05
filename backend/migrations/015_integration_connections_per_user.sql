-- 015_integration_connections_per_user.sql — make integration connections PER-USER.
--
-- Correction to 014: connections to the integration providers (Linear/Notion/Granola/Google Drive)
-- belong to a USER, not an agent — you connect your accounts once in Settings → Connections (like
-- GitHub and Gmail), then attach integrations to individual agents that use your connection. This
-- mirrors github_identities / google_identities (per participant); an agent's integration config
-- references the connecting user by id (config.backingParticipantId), exactly like the gmail
-- integration. So integration_connections is re-keyed from agent_id → participant_id.
--
-- Safe to drop+recreate: 014 shipped with zero rows (no one had connected yet). mcp_oauth_clients
-- (the per-provider DCR clients) is unchanged.

drop table if exists integration_connections;

create table if not exists integration_connections (
  participant_id    uuid not null references participants(id) on delete cascade,
  integration_key   text not null,                     -- catalog key: linear | notion | granola | google-drive
  external_account  text,                              -- display label (email, workspace name, provider)
  access_token      text not null,
  refresh_token     text,
  access_expires_at timestamptz,
  scopes            text,
  extra             jsonb not null default '{}'::jsonb, -- per-provider refresh material (token endpoint, issuer, …)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (participant_id, integration_key)
);
