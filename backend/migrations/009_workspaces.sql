-- 009_workspaces.sql — Slack-style multi-tenant workspaces.
--
-- Adds a `workspaces` table + shareable invite tokens, scopes `participants` and `channels` to a
-- workspace, and re-scopes handle/firebase_uid uniqueness per workspace. Every other table
-- (messages, channel_members, mentions, *_reads, agent_inbox, agent_events, attachments,
-- github_identities) inherits scope transitively through its FK to participants/channels.
--
-- Behaviour-neutral: all pre-existing rows are backfilled into one fixed "default" workspace, so
-- with a single workspace the app behaves exactly as before.

create table if not exists workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  max_agents  int,                                  -- null = env MAX_AGENTS_PER_WORKSPACE default
  created_at  timestamptz not null default now()
);

-- A shareable invite: anyone who opens /join/<token> and signs in can join the workspace.
-- Revocable (revoked_at) and optionally expiring (expires_at).
create table if not exists workspace_invites (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  token         text not null unique,               -- randomBytes(32) hex; used in the /join link
  created_by    uuid references participants(id) on delete set null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,                        -- null = never expires
  revoked_at    timestamptz                         -- non-null = revoked
);
create index if not exists workspace_invites_ws_idx on workspace_invites (workspace_id);

-- The default workspace holding all pre-existing data. Fixed id so dev-bypass, tests, and this
-- backfill all agree without extra config plumbing (mirrored as DEFAULT_WORKSPACE_ID in code).
insert into workspaces (id, name)
  values ('00000000-0000-0000-0000-000000000001', 'Jungle')
  on conflict (id) do nothing;

-- participants: workspace membership + role. Existing humans become admins (they predate invites).
alter table participants add column if not exists workspace_id uuid references workspaces(id);
alter table participants add column if not exists role text not null default 'member'
  check (role in ('admin', 'member'));
update participants set workspace_id = '00000000-0000-0000-0000-000000000001' where workspace_id is null;
update participants set role = 'admin' where kind = 'human' and role <> 'admin';
alter table participants alter column workspace_id set not null;

-- Handles + firebase uid are now unique PER WORKSPACE, not globally. (A human can hold a
-- different handle in each workspace they belong to; the same Google account maps to one
-- participant per workspace.)
alter table participants drop constraint if exists participants_handle_key;
create unique index if not exists participants_ws_handle_idx on participants (workspace_id, lower(handle));
alter table participants drop constraint if exists participants_firebase_uid_key;
create unique index if not exists participants_ws_uid_idx
  on participants (workspace_id, firebase_uid) where firebase_uid is not null;

-- channels: workspace. Members/messages/reads/mentions/attachments inherit scope through it.
alter table channels add column if not exists workspace_id uuid references workspaces(id);
update channels set workspace_id = '00000000-0000-0000-0000-000000000001' where workspace_id is null;
alter table channels alter column workspace_id set not null;
create index if not exists channels_ws_idx on channels (workspace_id);
