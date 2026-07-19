-- Slack integration: two-way channel mirroring via a single "Jungle" Slack app.
-- A Jungle workspace admin installs the app (OAuth v2, one bot token per Slack team, scoped to
-- their workspace), then links a Slack channel to a Jungle channel. Messages mirror both ways;
-- plaintext @agentname in Slack triggers the normal agent cascade. See services/slackBridge.ts.
--
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/023_slack.sql
-- (Mirrored into backend/db/schema.sql — keep both in sync.)

-- One Slack workspace (team) install per Jungle workspace. PK = workspace_id enforces the 1:1;
-- team_id is unique so an inbound event's team_id routes to exactly one install. Bot token stored
-- plaintext (matches the integration_connections MVP tradeoff — encrypt at rest before scale).
create table if not exists slack_installs (
  workspace_id  uuid primary key references workspaces(id) on delete cascade,
  team_id       text not null unique,
  team_name     text,
  bot_token     text not null,          -- xoxb-…
  bot_user_id   text not null,          -- U… id of our bot user (echo-drop on event.user)
  bot_id        text,                   -- B… id carried on our own posted messages (echo-drop)
  scopes        text,
  installed_by  uuid references participants(id) on delete set null,
  status        text not null default 'active' check (status in ('active', 'revoked')),
  created_at    timestamptz not null default now()
);

-- One Slack channel <-> one Jungle channel. jungle_channel_id unique => a Jungle channel mirrors
-- to at most one Slack channel; (team, slack_channel) unique => and vice versa.
create table if not exists slack_channel_links (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references slack_installs(workspace_id) on delete cascade,
  jungle_channel_id  uuid not null unique references channels(id) on delete cascade,
  slack_team_id      text not null,
  slack_channel_id   text not null,
  slack_channel_name text,              -- display cache for the UI badge/dialog
  status             text not null default 'active' check (status in ('active', 'error')),
  last_error         text,
  created_by         uuid references participants(id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (slack_team_id, slack_channel_id)
);

-- Slack user -> Jungle participant. 'shadow' = auto-created placeholder human; 'linked' = matched
-- an existing Jungle human by email (so their Slack messages attribute to their real account).
create table if not exists slack_user_links (
  slack_team_id   text not null,
  slack_user_id   text not null,
  participant_id  uuid not null references participants(id) on delete cascade,
  kind            text not null check (kind in ('shadow', 'linked')),
  created_at      timestamptz not null default now(),
  primary key (slack_team_id, slack_user_id)
);

-- Message identity map, both directions. origin says which side authored it: 'slack' = ingested
-- (egress must never mirror it back), 'jungle' = we posted it to Slack. slack_ts is a STRING
-- (Slack's message id / thread key) — never parse it as a number, precision loss breaks threading.
create table if not exists slack_message_links (
  jungle_message_id  uuid primary key references messages(id) on delete cascade,
  slack_team_id      text not null,
  slack_channel_id   text not null,
  slack_ts           text not null,
  slack_thread_ts    text,
  origin             text not null check (origin in ('slack', 'jungle'))
);
create unique index if not exists slack_message_links_slack_idx
  on slack_message_links (slack_team_id, slack_channel_id, slack_ts);

-- Events API delivers at-least-once; dedupe on event_id. Pruned (>24h) by the outbox ticker.
create table if not exists slack_events (
  event_id    text primary key,
  received_at timestamptz not null default now()
);

-- Transactional outbox for Jungle -> Slack delivery. Enqueued inside persistMessage's txn when the
-- channel is linked (and the message didn't originate from Slack), so message + mirror-intent
-- commit atomically. Drained by services/slackBridge.ts startSlackOutbox() ticker.
create table if not exists slack_outbox (
  id                 bigserial primary key,
  link_id            uuid not null references slack_channel_links(id) on delete cascade,
  jungle_message_id  uuid not null references messages(id) on delete cascade,
  status             text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts           int not null default 0,
  next_attempt_at    timestamptz not null default now(),
  last_error         text,
  created_at         timestamptz not null default now()
);
create index if not exists slack_outbox_pending_idx
  on slack_outbox (link_id, id) where status = 'pending';
