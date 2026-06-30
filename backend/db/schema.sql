-- Jungle schema — participant model.
-- See shared/docs/slack-agents-mvp-plan.md §6. Humans and agents are unified as
-- `participants`; a DM is just a channel with two members; messages reference a
-- sender participant and carry a monotonic `seq` for ordering / reconnect sync.

create table if not exists participants (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('human', 'agent')),
  handle        text not null unique,                 -- for @mentions: @sahil, @deploybot
  display_name  text not null,
  ma_session_id text,                                 -- set for agents; null for humans
  created_at    timestamptz not null default now()
);

-- GitHub-capable agents are provisioned at creation with a mounted repo + a vault holding
-- the GitHub MCP credential. These columns let us rotate the (1h) installation token before
-- each turn. Null for humans and non-GitHub agents.
alter table participants add column if not exists repo               text;
alter table participants add column if not exists vault_id           text;
alter table participants add column if not exists repo_resource_id   text;
alter table participants add column if not exists mcp_credential_id  text;

create table if not exists channels (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null check (kind in ('channel', 'dm')),  -- dm = exactly 2 members
  created_at  timestamptz not null default now()
);

create table if not exists channel_members (
  channel_id     uuid not null references channels(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  primary key (channel_id, participant_id)
);

create table if not exists messages (
  id             uuid primary key default gen_random_uuid(),
  channel_id     uuid not null references channels(id) on delete cascade,
  seq            bigint generated always as identity,  -- monotonic; "messages after seq N"
  sender_id      uuid not null references participants(id),
  body           text not null,
  client_msg_id  text,                                 -- optimistic-send idempotency
  ma_event_id    text,                                 -- links agent msg to its MA session event
  cascade_budget int,                                  -- remaining agent->agent hops; null for human msgs
  created_at     timestamptz not null default now()
);
create index if not exists messages_channel_seq_idx on messages (channel_id, seq);
create unique index if not exists messages_sender_client_msg_idx
  on messages (sender_id, client_msg_id) where client_msg_id is not null;

create table if not exists mentions (
  message_id     uuid not null references messages(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  primary key (message_id, participant_id)
);

-- A participant's connected GitHub account (via our GitHub App user-OAuth flow).
-- One identity per participant. Tokens expire (8h access, ~6mo refresh) — we store the
-- refresh token and renew on demand. MVP: stored in plaintext on the box; encrypt at rest
-- before any real multi-tenant deployment.
create table if not exists github_identities (
  participant_id      uuid primary key references participants(id) on delete cascade,
  github_login        text not null,
  github_user_id      bigint not null,
  access_token        text not null,
  refresh_token       text,
  access_expires_at   timestamptz,                      -- when access_token expires
  refresh_expires_at  timestamptz,                      -- when refresh_token expires
  scopes              text,                             -- space-delimited (informational)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
