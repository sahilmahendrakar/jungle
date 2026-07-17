-- 020: durable turn chips — the trigger-message activity chip needs to survive a page reload,
-- and one turn can be anchored to more than one message (a follow-up spliced into a turn already
-- in progress joins the SAME turn, not a new one). See frontend/src/components/chat/TurnChips.tsx
-- and backend/src/db/turns.ts.
--
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/020_turn_chips.sql

create table if not exists agent_turns (
  agent_id       uuid not null references participants(id) on delete cascade,
  turn_id        text not null,
  channel_id     uuid references channels(id) on delete cascade,
  thread_root_id uuid,
  started_at     timestamptz not null default now(),
  done_at        timestamptz,
  ok             boolean,
  primary key (agent_id, turn_id)
);
create index if not exists agent_turns_channel_idx on agent_turns (channel_id);

-- Many-to-one: every message that anchors to a turn (the original trigger, plus any follow-up
-- spliced into it mid-turn), so its chip renders under all of them, not just the first.
create table if not exists agent_turn_messages (
  agent_id    uuid not null,
  turn_id     text not null,
  message_id  uuid not null references messages(id) on delete cascade,
  joined_at   timestamptz not null default now(),
  primary key (agent_id, turn_id, message_id),
  foreign key (agent_id, turn_id) references agent_turns (agent_id, turn_id) on delete cascade
);
create index if not exists agent_turn_messages_message_idx on agent_turn_messages (message_id);
