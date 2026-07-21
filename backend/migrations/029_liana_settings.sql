-- Per-user Liana model preferences. Null = use the built-in default (Kimi K3). Two knobs only:
-- the model Liana herself thinks with (Slack intake), and the model NEW workflows start on
-- (each workflow's agent carries its own concrete model after creation — participants.model).
create table if not exists liana_settings (
  participant_id uuid primary key references participants(id) on delete cascade,
  liana_model    text,
  workflow_model text,
  updated_at     timestamptz not null default now()
);
