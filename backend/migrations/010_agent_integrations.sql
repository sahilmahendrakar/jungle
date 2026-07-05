-- 010_agent_integrations.sql — generalize "agent has a repo" into "agent has integrations".
--
-- An agent is no longer implicitly a coding agent: it starts as a blank chat agent (no rows
-- here) and can have zero or more integrations attached, each with its own config (github's
-- config holds `repo`; other integration types will hold whatever they need). Replaces
-- participants.repo as the source of truth — see backend/src/db/integrations.ts.

create table if not exists agent_integrations (
  agent_id        uuid not null references participants(id) on delete cascade,
  integration_key text not null,
  config          jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  primary key (agent_id, integration_key)
);

-- Backfill: every agent that already has a repo gets an implicit `github` integration row, so
-- existing agents keep working exactly as before.
insert into agent_integrations (agent_id, integration_key, config)
  select id, 'github', jsonb_build_object('repo', repo)
  from participants
  where kind = 'agent' and repo is not null
  on conflict (agent_id, integration_key) do nothing;
