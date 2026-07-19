-- Managed services (the runner's service_* tools: dev servers, watchers, tunnels).
-- Snapshot of the agent's service list as last reported via the `services` runner frame,
-- served on demand by GET /api/agents/:id/services (like the memory mirror).
alter table participants add column if not exists runner_services            jsonb;
alter table participants add column if not exists runner_services_updated_at timestamptz;
