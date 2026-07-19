-- 026: workflows — a team of agents + a trigger + a prose playbook, observable as runs.
--
-- Deliberately minimal (see shared/docs/workflows-plan.md): the roster is jsonb on the row (no
-- members table), the playbook is prose (no stage machine), and a run's transcript is derived —
-- it IS the thread under root_message_id plus the member turns whose agent_inbox.context carries
-- workflowRunId. Cron triggers reuse the schedules ticker: a backing schedules row with
-- workflow_id set fires workflow dispatch instead of a normal agent turn (and is hidden from the
-- /scheduled-style lists).
--
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/026_workflows.sql

create table if not exists workflows (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  name            text not null,
  description     text not null default '',
  emoji           text,
  status          text not null default 'draft' check (status in ('draft','active','paused')),
  template_id     text,           -- provenance: the template this was instantiated from
  home_channel_id uuid references channels(id) on delete set null,  -- null while draft
  trigger         jsonb not null default '{"type":"manual"}'::jsonb,
  roster          jsonb not null default '[]'::jsonb,  -- WorkflowRole[]; roster[0] = intake
  playbook        text not null default '',
  created_by      uuid references participants(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists workflows_ws_idx on workflows (workspace_id);

create table if not exists workflow_runs (
  id              uuid primary key default gen_random_uuid(),
  workflow_id     uuid not null references workflows(id) on delete cascade,
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  trigger         text not null check (trigger in ('schedule','manual','channel_message')),
  status          text not null default 'running' check (status in ('running','done','stalled','stopped')),
  root_message_id uuid references messages(id) on delete set null,  -- run-header = thread anchor
  summary         text,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz
);

create index if not exists workflow_runs_wf_idx on workflow_runs (workflow_id, started_at desc);
-- The stall/quiescence sweep scans live runs only.
create index if not exists workflow_runs_live_idx on workflow_runs (status)
  where status in ('running','stalled');

-- Schedules can back a workflow's cron trigger: the ticker dispatches a workflow run instead of
-- a normal agent turn, and such rows are hidden from schedule lists (they're managed from the
-- workflow, not the Scheduled surface).
alter table schedules add column if not exists workflow_id uuid references workflows(id) on delete cascade;
