-- Context-window occupancy for sdk agents, reported by the runner after each turn
-- (`context_usage` frame). Surfaced in the agent profile; null until the first report.
alter table participants add column if not exists context_tokens     integer;
alter table participants add column if not exists context_max_tokens integer;
alter table participants add column if not exists context_updated_at timestamptz;
