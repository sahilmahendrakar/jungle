-- Expo push tokens for the iOS app (Phase 7). Account-scoped (firebase_uid), so one phone serves
-- all of a user's workspaces — mirroring the uid-keyed socket map. The token is the Expo push
-- token string ("ExponentPushToken[...]"); we prune it on a DeviceNotRegistered receipt.
create table if not exists push_tokens (
  token         text primary key,
  firebase_uid  text not null,
  platform      text not null default 'ios',
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists push_tokens_uid_idx on push_tokens (firebase_uid);
