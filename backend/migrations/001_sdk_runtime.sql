-- 001_sdk_runtime.sql — second agent runtime (per-agent "runner" container).
--
-- Existing agents run on Anthropic Managed Agents (runtime='ma', driven by ma.ts). This
-- migration adds the columns + tables the SDK runner path needs. It is additive and
-- idempotent (safe to re-run); the same statements are mirrored into db/schema.sql so the
-- repo's `npm run db:migrate` (which applies schema.sql) stays the source of truth.
--
-- Apply with:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/001_sdk_runtime.sql
-- (The orchestrator applies this — do NOT run it against the live DB from here.)

-- participants: which runtime an agent uses, and its per-agent runner secret.
-- Existing rows default to 'ma' so nothing already running changes behaviour.
-- (model/mode columns already exist from schema.sql; for sdk agents `mode` stores an SDK
-- permission mode: default|acceptEdits|plan|bypassPermissions|dontAsk.)
alter table participants add column if not exists runtime      text not null default 'ma';
alter table participants add column if not exists runner_token  text;
create unique index if not exists participants_runner_token_idx
  on participants (runner_token) where runner_token is not null;

-- agent_inbox: durable work queue for an sdk agent. A dispatch inserts a row; the runner
-- pulls it (via `enqueue`) and acks it (`consumed`), at which point delivered_at is set.
-- Undelivered rows survive a runner being offline and are re-sent on reconnect.
create table if not exists agent_inbox (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid not null references participants(id) on delete cascade,
  text          text not null,
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz,                 -- set when the runner acks via `consumed`
  turn_id       text                          -- the turn that consumed this item (from `consumed`)
);
-- Fast lookup of pending work for one agent (the drain query).
create index if not exists agent_inbox_pending_idx
  on agent_inbox (agent_id) where delivered_at is null;

-- agent_events: every SDK stream message from a runner, persisted for the Activity feed.
create table if not exists agent_events (
  id          bigserial primary key,
  agent_id    uuid not null references participants(id) on delete cascade,
  turn_id     text,
  event       jsonb not null,
  created_at  timestamptz not null default now()
);
-- Newest-first reads per agent.
create index if not exists agent_events_agent_id_idx on agent_events (agent_id, id desc);
