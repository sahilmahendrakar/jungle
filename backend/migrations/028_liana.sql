-- Liana: the Slack-first workflow product riding the jungle workflow engine.
-- A Liana workflow is an ordinary workflows row (single-role roster, schedule trigger,
-- playbook = the user's prompt) plus a liana_workflows ownership row. Runs execute through
-- the existing scheduler/workflow-run machinery; on run close the agent's thread messages
-- are delivered to the owner's Slack DM (liana_deliveries makes that idempotent).
-- The Liana Slack app is a SEPARATE app from the channel-mirroring one (own credentials,
-- own installs table); slack_user_links is shared so a person maps to one participant.

create table if not exists liana_slack_installs (
  team_id      text primary key,
  team_name    text,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  bot_token    text not null,
  bot_user_id  text not null,
  scopes       text,
  status       text not null default 'active' check (status in ('active','revoked')),
  installed_at timestamptz not null default now()
);

create table if not exists liana_workflows (
  workflow_id          uuid primary key references workflows(id) on delete cascade,
  team_id              text not null references liana_slack_installs(team_id) on delete cascade,
  slack_user_id        text not null,
  owner_participant_id uuid not null references participants(id) on delete cascade,
  -- The IM channel we deliver runs to (opened lazily via conversations.open).
  dm_channel_id        text,
  -- The channel+thread of the mention that created the workflow, so lifecycle notices
  -- (created / auto-paused) can land where the conversation happened.
  origin_channel_id    text,
  origin_thread_ts     text,
  created_at           timestamptz not null default now()
);
create index if not exists liana_workflows_owner_idx on liana_workflows (team_id, slack_user_id);

-- One delivery attempt record per run; the insert-once guard is what makes delivery idempotent.
create table if not exists liana_deliveries (
  run_id       uuid primary key references workflow_runs(id) on delete cascade,
  status       text not null check (status in ('delivered','failed')),
  error        text,
  delivered_at timestamptz not null default now()
);
