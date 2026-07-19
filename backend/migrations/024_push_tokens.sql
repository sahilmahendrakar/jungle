-- Mobile push tokens (FCM registration tokens; iOS today). Account-scoped like devices — one
-- account's phone should get pushes from all of its workspaces. Upserted by
-- POST /api/push/register; pruned when FCM reports a token dead.
create table if not exists push_tokens (
  token text primary key,
  firebase_uid text not null,
  platform text not null default 'ios',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists push_tokens_uid_idx on push_tokens (firebase_uid);
