-- Liana as a persistent per-user agent.
--
-- Each Liana owner gets one durable Agent-SDK "Liana" agent (a normal participants row, runtime
-- 'sdk') that holds their conversation, memory, and tools. `liana_agent_id` maps the owner to it.
-- `agent_enabled` gates the new agent path per owner during rollout: false = the legacy stateless
-- intake (services/lianaIntake.ts) still answers; true = messages dispatch to the owner's Liana
-- agent. Lets us canary a handful of owners before flipping the default.

alter table liana_settings
  add column if not exists liana_agent_id uuid references participants(id) on delete set null,
  add column if not exists agent_enabled  boolean not null default false;

-- The owner->agent lookup used on every inbound message when the flag is on.
create index if not exists liana_settings_agent_id_idx on liana_settings (liana_agent_id);
