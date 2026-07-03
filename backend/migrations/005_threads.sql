-- 005_threads.sql — Slack-style threads.
--
-- A "thread" is a root message plus every message whose thread_root_id points at it. Replies
-- live in the same messages table / same per-channel `seq` stream as everything else, so the
-- existing reconnect-sync (getMessages by afterSeq), fanout, and cascade machinery all just
-- work — the client buckets roots→timeline and replies→thread pane.
--
-- Design decisions (see the plan discussion):
--   * Participation is DERIVED, not stored: a thread's followers = {root author} ∪ {repliers}
--     ∪ {@mentioned in the thread}, all already in messages/mentions. No thread_participants
--     table, no sync code, no second source of truth to drift.
--   * reply_count + last_reply_at are denormed on the root (read on every channel render,
--     O(1) to maintain in persistMessage's txn). There is no single-message delete anywhere
--     in the app (only cascading channel/agent delete), so these counters can't drift.
--   * Per-thread read state gets its own table (thread_reads) — the read cursor is the one
--     thing that genuinely can't be derived. Mirrors channel_reads exactly.
--
-- Additive + idempotent (safe to re-run); mirrored into db/schema.sql (the source of truth).
--
-- Apply with:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/005_threads.sql

-- A reply points at its thread's root message. Null = a top-level message (which may itself be
-- a thread root once it gets replies). Replies never nest: thread_root_id always references a
-- message whose own thread_root_id is null (enforced in persistMessage).
alter table messages add column if not exists thread_root_id uuid references messages(id) on delete cascade;

-- A thread reply that the author also chose to echo into the main channel timeline
-- ("also send to channel"). Purely a placement flag: such a reply shows in BOTH the thread
-- pane and the main timeline, and — unlike a normal reply — counts toward the channel's
-- unread badge (it is a channel message too).
alter table messages add column if not exists also_to_channel boolean not null default false;

-- Denormalized thread summary, maintained on the ROOT message only (null/0 on replies and on
-- childless messages). reply_count drives the "N replies" footer; last_reply_at orders the
-- Threads view.
alter table messages add column if not exists reply_count int not null default 0;
alter table messages add column if not exists last_reply_at timestamptz;

-- Replies of a thread, in order. Partial (replies only) since most messages are top-level.
create index if not exists messages_thread_idx on messages (thread_root_id, seq)
  where thread_root_id is not null;

-- Slack-style per-participant read state for THREADS — the exact shape of channel_reads but
-- keyed on the thread's root message. One row per (root, participant) records the highest
-- message seq that participant has read within that thread; the threads-unread queries
-- left-join this the same way listChannels joins channel_reads.
create table if not exists thread_reads (
  root_id        uuid not null references messages(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  last_read_seq  bigint not null default 0,   -- highest seq this participant has read in the thread
  updated_at     timestamptz not null default now(),
  primary key (root_id, participant_id)
);
