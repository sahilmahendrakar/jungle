-- Per-device sandbox toggle for self-hosted environments. When true (the default, and the
-- historical behavior) an agent's runner child gets an isolated per-agent workspace dir under
-- ~/.jungle-agents/agents/<id>/workspace. When false the daemon instead points the child's
-- JUNGLE_WORKSPACE at the directory `jungle-agents connect` was run from, so the agent runs
-- directly in the user's chosen working directory with their real files. Per-agent state
-- (session transcripts, memory, git config/credentials) stays isolated either way. See
-- runner/src/daemon.ts (spawnChild) and shared/src/host-protocol.ts (RunAgentFrame).
alter table runner_hosts
  add column if not exists sandboxed boolean not null default true;
