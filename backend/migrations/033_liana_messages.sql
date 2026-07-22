-- Liana conversational memory: a bounded rolling transcript per conversation, fed into the
-- intake call so follow-ups ("actually make it 9am") resolve. Deliberately NOT a session store:
-- rows are pruned aggressively (read window is ~24h / last dozen turns; writes prune >7 days),
-- and durable state (the workflow list) stays in the system prompt as the source of truth.
--
-- convo_key scopes memory to the conversation, not the user:
--   slack:<channel>              (DMs)
--   slack:<channel>:<thread_ts>  (in-channel mentions)
--   imessage:<phone>
--   telegram:<chat_id>
create table if not exists liana_messages (
  id             bigint generated always as identity primary key,
  participant_id uuid not null references participants(id) on delete cascade,
  convo_key      text not null,
  role           text not null check (role in ('user', 'assistant')),
  body           text not null,
  created_at     timestamptz not null default now()
);
create index if not exists liana_messages_convo_idx
  on liana_messages (participant_id, convo_key, created_at desc);
