-- Jungle schema — participant model.
-- See shared/docs/slack-agents-mvp-plan.md §6. Humans and agents are unified as
-- `participants`; a DM is just a channel with two members; messages reference a
-- sender participant and carry a monotonic `seq` for ordering / reconnect sync.

-- Slack-style multi-tenancy: everything (participants, channels, and all they own) is scoped to
-- a workspace. See migrations/009_workspaces.sql.
create table if not exists workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  max_agents  int,                                  -- null = env MAX_AGENTS_PER_WORKSPACE default
  created_at  timestamptz not null default now()
);
-- The default workspace holds all rows created before multi-tenancy. Fixed id so dev-bypass,
-- tests, and the 009 backfill all agree (mirrored as DEFAULT_WORKSPACE_ID in code).
insert into workspaces (id, name)
  values ('00000000-0000-0000-0000-000000000001', 'Jungle')
  on conflict (id) do nothing;

create table if not exists participants (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('human', 'agent')),
  handle        text not null,                        -- for @mentions: @sahil, @deploybot (unique per workspace)
  display_name  text not null,
  created_at    timestamptz not null default now()
);

-- A GitHub-capable agent stores its repo ("owner/name"); the SDK runner clones it and gets a
-- fresh installation token in each `configure`. Null for humans and non-GitHub agents.
alter table participants add column if not exists repo               text;

-- Identity: a human participant is linked to a Firebase Auth user (Google sign-in). These
-- are null for agents and for legacy/dev participants created via the ?as= dev path.
-- (firebase_uid is unique PER WORKSPACE — the ws-scoped index below — so one Google account can
-- map to a participant in each workspace it belongs to.)
alter table participants add column if not exists firebase_uid       text;
alter table participants add column if not exists email              text;
alter table participants add column if not exists avatar_url         text;
-- Agent config: model override (null = agent-config default) + tool permission mode
-- (SDK permission mode: default|acceptEdits|plan|bypassPermissions|dontAsk).
alter table participants add column if not exists model              text;
alter table participants add column if not exists mode               text not null default 'default';
-- Reasoning effort (Agent SDK `effort`): low|medium|high|xhigh. Default 'medium'. See migrations/008_agent_effort.sql.
alter table participants add column if not exists effort             text not null default 'medium';

-- Agents run on a per-agent SDK runner container that dials into /api/runner with runner_token
-- and speaks docs/runner-protocol.md. See migrations 001_sdk_runtime.sql + 002_drop_ma_columns.sql.
alter table participants add column if not exists runtime      text not null default 'sdk';
alter table participants add column if not exists runner_token  text;
create unique index if not exists participants_runner_token_idx
  on participants (runner_token) where runner_token is not null;

-- Context-window occupancy for sdk agents, reported by the runner after each turn
-- (`context_usage` frame). Surfaced in the agent profile; null until the first report.
-- See migrations/006_context_usage.sql.
alter table participants add column if not exists context_tokens     integer;
alter table participants add column if not exists context_max_tokens integer;
alter table participants add column if not exists context_updated_at timestamptz;

-- Durable agent memory (mirror of the runner's /workspace/MEMORY.md, reported via the `memory`
-- frame) + creator-written persona injected into the system prompt.
-- See migrations/016_agent_memory_persona.sql.
alter table participants add column if not exists memory             text;
alter table participants add column if not exists memory_updated_at  timestamptz;
alter table participants add column if not exists persona            text;

-- Per-agent runner provider (gradual Docker -> Fly rollout). 'docker' keeps today's behavior;
-- 'fly' routes provisioner calls to FlyProvisioner. runner_meta holds provider handles
-- (Fly: {machineId, volumeId}); null for docker. See migrations/007_fly_provisioner.sql.
alter table participants add column if not exists runner_provider text not null default 'docker';
alter table participants add column if not exists runner_meta jsonb;

-- Multi-tenancy: which workspace this participant belongs to, and their role in it. Membership is
-- implicit (a participant row = a membership); 'admin' (workspace creator) gates invites + config.
-- See migrations/009_workspaces.sql. Handles + firebase_uid are unique per workspace, not global.
alter table participants add column if not exists workspace_id uuid references workspaces(id);
alter table participants add column if not exists role text not null default 'member'
  check (role in ('admin', 'member'));
update participants set workspace_id = '00000000-0000-0000-0000-000000000001' where workspace_id is null;
alter table participants alter column workspace_id set not null;
alter table participants drop constraint if exists participants_handle_key;
create unique index if not exists participants_ws_handle_idx on participants (workspace_id, lower(handle));
alter table participants drop constraint if exists participants_firebase_uid_key;
create unique index if not exists participants_ws_uid_idx
  on participants (workspace_id, firebase_uid) where firebase_uid is not null;

-- Shareable workspace invites: anyone who opens /join/<token> and signs in can join. Revocable
-- (revoked_at) and optionally expiring (expires_at).
create table if not exists workspace_invites (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  token         text not null unique,               -- randomBytes(32) hex; used in the /join link
  created_by    uuid references participants(id) on delete set null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,                        -- null = never expires
  revoked_at    timestamptz                         -- non-null = revoked
);
create index if not exists workspace_invites_ws_idx on workspace_invites (workspace_id);

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
-- Multi-tenancy: the workspace this channel lives in. Members/messages/reads/mentions/attachments
-- inherit scope through it. See migrations/009_workspaces.sql.
alter table channels add column if not exists workspace_id uuid references workspaces(id);
update channels set workspace_id = '00000000-0000-0000-0000-000000000001' where workspace_id is null;
alter table channels alter column workspace_id set not null;
create index if not exists channels_ws_idx on channels (workspace_id);

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
-- Threads (see migrations/005_threads.sql). A reply's thread_root_id points at its thread's
-- root message (null = top-level). also_to_channel echoes a reply into the main timeline.
-- reply_count/last_reply_at are denormed on the ROOT only. Thread participation is DERIVED
-- (root author ∪ repliers ∪ mentioned) — there is no thread_participants table.
alter table messages add column if not exists thread_root_id uuid references messages(id) on delete cascade;
alter table messages add column if not exists also_to_channel boolean not null default false;
alter table messages add column if not exists reply_count int not null default 0;
alter table messages add column if not exists last_reply_at timestamptz;
create index if not exists messages_channel_seq_idx on messages (channel_id, seq);
create index if not exists messages_thread_idx on messages (thread_root_id, seq)
  where thread_root_id is not null;
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

-- Slack-style per-participant read state for THREADS — the same shape as channel_reads but
-- keyed on the thread's root message. Powers participation-gated thread unreads. See
-- migrations/005_threads.sql.
create table if not exists thread_reads (
  root_id        uuid not null references messages(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  last_read_seq  bigint not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (root_id, participant_id)
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

-- An agent is not necessarily a coding agent: it starts as a blank chat agent (no rows here)
-- and can have zero or more integrations attached, each with its own config (github's config
-- holds `repo`). Replaces participants.repo as the source of truth for what an agent can do.
-- See migrations/010_agent_integrations.sql and backend/src/db/integrations.ts.
create table if not exists agent_integrations (
  agent_id        uuid not null references participants(id) on delete cascade,
  integration_key text not null,
  config          jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  primary key (agent_id, integration_key)
);

-- A participant's connected Google account (Gmail OAuth, offline access). One per participant,
-- mirroring github_identities. An agent's `gmail` integration references the connecting user by
-- id and mints access tokens from this row at runtime (see migrations/013_google_identities.sql
-- and backend/src/google.ts). MVP: plaintext on the box; encrypt at rest before real multi-tenant.
create table if not exists google_identities (
  participant_id    uuid primary key references participants(id) on delete cascade,
  email             text not null,
  access_token      text not null,
  refresh_token     text,
  access_expires_at timestamptz,
  scopes            text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Per-USER OAuth connections for the connection-based integrations (Linear/Notion/Granola via
-- their remote MCP servers, Google Drive). You connect your accounts once in Settings (like
-- github_identities / google_identities); an agent's integration references the connecting user by
-- id (config.backingParticipantId), like the gmail integration. `extra` holds per-provider refresh
-- material. mcp_oauth_clients stores the OAuth client registered (once, via DCR) per remote MCP
-- provider. See migrations/014 + 015_integration_connections_per_user.sql and
-- backend/src/db/connections.ts. MVP: plaintext; encrypt at rest before real multi-tenant.
create table if not exists integration_connections (
  participant_id    uuid not null references participants(id) on delete cascade,
  integration_key   text not null,
  external_account  text,
  access_token      text not null,
  refresh_token     text,
  access_expires_at timestamptz,
  scopes            text,
  extra             jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (participant_id, integration_key)
);

create table if not exists mcp_oauth_clients (
  provider_key      text primary key,
  issuer            text not null,
  client_id         text not null,
  client_secret     text,
  metadata          jsonb not null default '{}'::jsonb,
  registered_at     timestamptz not null default now()
);

-- Per-dispatch context (cascade budget, trigger channel/thread, firing schedule id) rides on
-- each inbox item; the agent's active context = its most recently consumed item's context.
-- Replaces orchestrator.ts's in-memory sdkContext map (raced across queued dispatches, lost on
-- restart). See migrations/011_inbox_context.sql.
alter table agent_inbox add column if not exists context jsonb;
create index if not exists agent_inbox_ctx_idx on agent_inbox (agent_id, delivered_at desc)
  where context is not null;

-- Schedules: standing instructions that fire agent turns on a cadence — recurring (cron +
-- IANA timezone) or one-shot (run_at). The ticker advances next_run_at BEFORE dispatching
-- (crash mid-fire = skipped fire, never a double-fire). channel_id is only dispatch context
-- (confirm cards, default thread routing, notices) — output is not forced there.
-- See migrations/012_schedules.sql and backend/src/services/scheduler.ts.
create table if not exists schedules (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  agent_id      uuid not null references participants(id) on delete cascade,
  channel_id    uuid not null references channels(id) on delete cascade,
  created_by    uuid references participants(id) on delete set null,
  prompt        text not null,
  cron          text,           -- recurring: 5-field cron expression
  timezone      text,           -- IANA tz the cron is evaluated in
  run_at        timestamptz,    -- one-shot fire time
  next_run_at   timestamptz,    -- null = will never fire again (completed one-shot)
  paused_at     timestamptz,    -- non-null = paused (manually, or auto after repeated failures)
  last_run_at   timestamptz,
  last_status   text check (last_status in ('pending','success','failure')),
  last_error    text,
  failure_count int not null default 0,  -- consecutive failed turns; reset on success
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check ((cron is not null and timezone is not null and run_at is null)
      or (cron is null and timezone is null and run_at is not null))
);
create index if not exists schedules_due_idx on schedules (next_run_at)
  where next_run_at is not null and paused_at is null;
create index if not exists schedules_ws_idx    on schedules (workspace_id);
create index if not exists schedules_agent_idx on schedules (agent_id);
