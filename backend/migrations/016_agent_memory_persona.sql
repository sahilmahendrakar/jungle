-- Durable agent memory + user-editable persona.
-- `memory` mirrors the agent's /workspace/MEMORY.md (reported by the runner via the `memory`
-- frame after any turn that changed it) so the profile panel can show it even while the
-- machine sleeps. `persona` is the creator-written role/personality injected into the agent's
-- system prompt (see runners.ts systemPromptAppend).
alter table participants add column if not exists memory             text;
alter table participants add column if not exists memory_updated_at  timestamptz;
alter table participants add column if not exists persona            text;
