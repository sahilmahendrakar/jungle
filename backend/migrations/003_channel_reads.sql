-- 003_channel_reads.sql — Slack-style per-participant read state for unread tracking.
--
-- One row per (channel, participant) records the highest message seq that participant has
-- read. The channel-list endpoint left-joins this to compute unread_count / has_mention for
-- the requesting human. Agents are participants too but never "read" channels — we only ever
-- upsert/read this table for humans, so agent rows simply never appear here.
--
-- Additive + idempotent (safe to re-run); mirrored into db/schema.sql (the source of truth).
--
-- Apply with:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/003_channel_reads.sql

create table if not exists channel_reads (
  channel_id     uuid not null references channels(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  last_read_seq  bigint not null default 0,   -- highest message seq this participant has read
  updated_at     timestamptz not null default now(),
  primary key (channel_id, participant_id)
);
