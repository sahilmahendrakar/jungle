-- Per-channel delivery outcomes for a Liana workflow run. Before this, liana_deliveries carried a
-- single status/error for the whole fan-out, so a channel that was silently skipped (provider not
-- configured, no verified link) or that failed while another succeeded left no user-visible trace.
-- `channels` records one entry per attempted channel, e.g. {"slack":"ok","imessage":"failed: …"}.
-- The legacy status/error columns stay for backward compat (status = worst-case rollup).
alter table liana_deliveries add column if not exists channels jsonb not null default '{}'::jsonb;
