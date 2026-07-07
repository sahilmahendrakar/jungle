-- Deliverables: durable work artifacts agents produce (PRs, docs, issues, …), extracted from the
-- links in their messages at send time (services/deliverables.ts). Chat scrolls away; this table
-- is the workspace's lasting "what got shipped" record, powering the Deliverables feed and the
-- per-agent "last shipped" on the agents overview.
--
-- unique (workspace_id, url): an agent re-linking the same PR in a follow-up doesn't double-count.
create table if not exists deliverables (
  id           bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id     uuid not null references participants(id) on delete cascade,
  channel_id   uuid not null references channels(id) on delete cascade,
  message_id   uuid not null references messages(id) on delete cascade,
  kind         text not null,   -- github_pr | github_issue | github | notion | google_doc | google_drive | linear | granola
  title        text,            -- from the markdown link text when the agent gave one
  url          text not null,
  created_at   timestamptz not null default now(),
  unique (workspace_id, url)
);
create index if not exists deliverables_ws_idx on deliverables (workspace_id, id desc);
create index if not exists deliverables_agent_idx on deliverables (agent_id, id desc);
