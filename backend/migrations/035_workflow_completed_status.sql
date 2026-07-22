-- 035: allow workflows.status = 'completed' — the terminal state of a one-time ('once' trigger)
-- workflow after its single run has fired. The status check was defined inline in 026 (create
-- table), so Postgres auto-named it workflows_status_check; drop and recreate it with the new value.
--
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/035_workflow_completed_status.sql

alter table workflows drop constraint if exists workflows_status_check;
alter table workflows add constraint workflows_status_check
  check (status in ('draft','active','paused','completed'));
