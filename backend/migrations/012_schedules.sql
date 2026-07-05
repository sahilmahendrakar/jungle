-- 012: schedules — standing instructions that fire agent turns on a cadence.
--
-- Recurring (5-field cron evaluated in an IANA timezone) or one-shot (run_at). The ticker
-- (backend/src/services/scheduler.ts) advances next_run_at BEFORE dispatching, so a crash
-- mid-fire skips that fire rather than double-firing. channel_id is only the schedule's
-- dispatch context (confirm cards, default thread routing, notices) — output is not forced
-- there; a fired turn may legitimately send nothing.
--
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/012_schedules.sql

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
