-- Self-hosted devices. A "device" (runner_host) is a machine a user registers with
-- `jungle-runner connect`; agents with runner_provider='self_hosted' run on it. A device is
-- ACCOUNT-scoped (owner_uid = Firebase uid), so it's selectable across all of that account's
-- workspaces. The device's daemon dials the host-control channel (/api/host, see
-- shared/src/host-protocol.ts) with a bearer device token; the backend tells it which agents to
-- run, and the daemon spawns/kills per-agent runner children that dial /api/runner as usual.
create table if not exists runner_hosts (
  id                   uuid primary key default gen_random_uuid(),
  owner_uid            text not null,                       -- Firebase uid of the registering account
  name                 text not null,                       -- user-editable; defaults to the hostname
  hostname             text,
  platform             text,                                -- process.platform (darwin|linux|…)
  arch                 text,                                -- process.arch (arm64|x64|…)
  runner_version       text,
  device_token_hash    text not null unique,                -- sha256 of the bearer device token (secret never stored raw)
  assign_policy        text not null default 'owner_only',  -- owner_only | workspace_members
  shared_workspace_ids uuid[] not null default '{}',        -- workspaces the device is shared into (workspace_members)
  created_at           timestamptz not null default now(),
  last_seen_at         timestamptz,                         -- last host-control activity (hello/heartbeat/close)
  revoked_at           timestamptz                          -- soft delete; a revoked token can't reconnect
);
create index if not exists runner_hosts_owner_idx on runner_hosts (owner_uid) where revoked_at is null;

-- OAuth-device-grant-style flow backing `jungle-runner connect`: the CLI starts a request (gets a
-- device_code it polls with + a short human user_code), the signed-in web user approves the
-- user_code, then the CLI exchanges the approved device_code for a durable device token (which
-- also creates the runner_hosts row). Rows are short-lived and single-use.
create table if not exists device_auth_requests (
  device_code   text primary key,                           -- opaque secret the CLI polls with
  user_code     text not null unique,                       -- short code shown/typed by the human (e.g. WXYZ-1234)
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  approved_uid  text,                                        -- Firebase uid that approved (null until approved)
  approved_at   timestamptz,
  host_id       uuid references runner_hosts(id) on delete set null,  -- the device created at token exchange
  claimed_at    timestamptz                                  -- when the CLI exchanged it for a token
);
