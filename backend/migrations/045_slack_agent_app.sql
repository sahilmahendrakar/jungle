-- Slack agent app: a SECOND Slack app per workspace, alongside the existing channel-mirror app.
--
-- Why a second app rather than new features on the mirror app: Slack's `features.agent_view` (the
-- agent DM experience — messages tab, in-thread replies, suggested prompts) is a ONE-WAY switch
-- that applies to every user of the app. Flipping it on the live mirroring app is unrevertable, so
-- the agent experience gets its own app and the mirror keeps working exactly as it does today.
--
-- The model: `slack_installs` gains a `kind` ('mirror' | 'agent'), so one Jungle workspace can hold
-- one install of each, both pointing at the same Slack team. An agent's DM is then represented as
-- an ordinary row in `slack_channel_links` (Jungle DM channel <-> Slack IM channel "D…"), which
-- means ingress (getLinkBySlackChannel) and the whole transactional outbox (enqueueOutboxIfLinked
-- -> claimDueOutbox -> chat.postMessage) work on DMs with NO new code. `dm_agent_id` marks those
-- rows so the Settings UI never lists them as channel mirrors.
--
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/045_slack_agent_app.sql
-- (Mirrored into backend/db/schema.sql — keep both in sync.)

-- --- New columns first (the composite FK below needs install_kind to exist) ---

alter table slack_installs
  add column if not exists kind text not null default 'mirror'
    check (kind in ('mirror', 'agent'));

alter table slack_channel_links
  add column if not exists install_kind text not null default 'mirror'
    check (install_kind in ('mirror', 'agent'));

-- The agent whose DM this row binds, when it is a DM binding rather than a channel mirror. Null for
-- every existing (channel-mirror) row.
alter table slack_channel_links
  add column if not exists dm_agent_id uuid references participants(id) on delete cascade;

-- The Slack user on the other side of that DM (a DM is per-person, unlike a channel mirror).
alter table slack_channel_links
  add column if not exists dm_slack_user_id text;

-- --- Repoint the parent key: workspace_id -> (workspace_id, kind), so a workspace can hold both
-- --- installs. Order matters — the child FK depends on the parent's PK index, so it must be
-- --- dropped BEFORE the PK and re-created against the new composite key afterwards.
-- ---
-- --- Guarded on "is the PK already composite?" and run as one block, because on a re-run the FK
-- --- we create at the end would itself block the PK drop at the start. Migrations here are applied
-- --- by hand, so re-running one must be a no-op rather than an error.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'slack_installs'::regclass and contype = 'p' and array_length(conkey, 1) = 2
  ) then
    return;
  end if;

  alter table slack_channel_links drop constraint if exists slack_channel_links_workspace_id_fkey;
  alter table slack_channel_links drop constraint if exists slack_channel_links_install_fkey;

  alter table slack_installs drop constraint if exists slack_installs_pkey;
  alter table slack_installs add primary key (workspace_id, kind);

  -- team_id was globally unique (one Slack team routes to one install). The same Slack team now
  -- legitimately hosts BOTH our apps, so uniqueness moves to (team_id, kind) — an inbound event
  -- still routes to exactly one install once you know which app's webhook received it.
  alter table slack_installs drop constraint if exists slack_installs_team_id_key;

  alter table slack_channel_links
    add constraint slack_channel_links_install_fkey
    foreign key (workspace_id, install_kind)
    references slack_installs (workspace_id, kind) on delete cascade;
end $$;

create unique index if not exists slack_installs_team_kind_idx on slack_installs (team_id, kind);

-- Fast lookup of "does this agent already have a DM bound for this Slack user".
create index if not exists slack_channel_links_dm_idx
  on slack_channel_links (dm_agent_id, dm_slack_user_id) where dm_agent_id is not null;
