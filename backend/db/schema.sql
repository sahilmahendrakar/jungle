-- Jungle schema — participant model.
-- See shared/docs/slack-agents-mvp-plan.md §6. Humans and agents are unified as
-- `participants`; a DM is just a channel with two members; messages reference a
-- sender participant and carry a monotonic `seq` for ordering / reconnect sync.

create table if not exists participants (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('human', 'agent')),
  handle        text not null unique,                 -- for @mentions: @sahil, @deploybot
  display_name  text not null,
  created_at    timestamptz not null default now()
);

-- A GitHub-capable agent stores its repo ("owner/name"); the SDK runner clones it and gets a
-- fresh installation token in each `configure`. Null for humans and non-GitHub agents.
alter table participants add column if not exists repo               text;

-- Identity: a human participant is linked to a Firebase Auth user (Google sign-in). These
-- are null for agents and for legacy/dev participants created via the ?as= dev path.
alter table participants add column if not exists firebase_uid       text unique;
alter table participants add column if not exists email              text;
alter table participants add column if not exists avatar_url         text;
-- Agent config: model override (null = agent-config default) + tool permission mode
-- (SDK permission mode: default|acceptEdits|plan|bypassPermissions|dontAsk).
alter table participants add column if not exists model              text;
alter table participants add column if not exists mode               text not null default 'default';

-- Agents run on a per-agent SDK runner container that dials into /api/runner with runner_token
-- and speaks docs/runner-protocol.md. See migrations 001_sdk_runtime.sql + 002_drop_ma_columns.sql.
alter table participants add column if not exists runtime      text not null default 'sdk';
alter table participants add column if not exists runner_token  text;
create unique index if not exists participants_runner_token_idx
  on participants (runner_token) where runner_token is not null;

-- Durable per-agent work queue for sdk runners. A dispatch inserts a row; the runner pulls it
-- (`enqueue`) and acks it (`consumed`) -> delivered_at set. Undelivered rows survive the runner
-- being offline and are re-sent on reconnect.
create table if not exists agent_inbox (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid not null references participants(id) on delete cascade,
  text          text not null,
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz,
  turn_id       text
);
create index if not exists agent_inbox_pending_idx
  on agent_inbox (agent_id) where delivered_at is null;

-- Every SDK stream message from a runner, persisted for the Activity feed.
create table if not exists agent_events (
  id          bigserial primary key,
  agent_id    uuid not null references participants(id) on delete cascade,
  turn_id     text,
  event       jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists agent_events_agent_id_idx on agent_events (agent_id, id desc);

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

-- Slack-style per-participant read state. One row per (channel, participant) records the
-- highest message seq that participant has read; the channel-list endpoint uses it to compute
-- unread_count / has_mention for the requesting human. Agents never "read" channels, so their
-- rows simply never appear here. See migrations/003_channel_reads.sql.
create table if not exists channel_reads (
  channel_id     uuid not null references channels(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  last_read_seq  bigint not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (channel_id, participant_id)
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

-- Attachments: files that ride on chat messages, stored via the backend's Storage seam
-- (local disk today, S3-compatible later — keys are S3-shaped). Upload-first flow: rows are
-- created at upload with message_id null; posting the message links them; never-linked rows
-- are GC'd after 24h. See migrations/004_attachments.sql.
create table if not exists attachments (
  id           uuid primary key default gen_random_uuid(),
  uploader_id  uuid not null references participants(id) on delete cascade,
  message_id   uuid references messages(id) on delete cascade,
  filename     text not null,
  mime         text not null,
  size_bytes   bigint not null,
  storage_key  text not null,
  width        int,          -- images only (layout hint for the UI)
  height       int,
  created_at   timestamptz not null default now()
);
create index if not exists attachments_message_idx on attachments (message_id);
create index if not exists attachments_orphan_idx on attachments (created_at)
  where message_id is null;

-- Inbox items carry the triggering message's attachment refs (jsonb); URLs signed at drain.
alter table agent_inbox add column if not exists attachments jsonb;
