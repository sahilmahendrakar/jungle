import { randomBytes, createHash } from "node:crypto";
import type { DeviceAssignPolicy } from "@jungle/shared";
import { pool } from "./pool";
import { withTransaction } from "./tx";

// Data layer for self-hosted devices (runner_hosts) and the device-code auth flow
// (device_auth_requests). See migrations/021_runner_hosts.sql and shared/src/host-protocol.ts.
// A device is account-scoped (owner_uid = Firebase uid); its bearer device token is stored only
// as a sha256 hash. The raw token is returned exactly once (at claim) and never persisted.

export interface RunnerHostRow {
  id: string;
  owner_uid: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  arch: string | null;
  runner_version: string | null;
  device_token_hash: string;
  assign_policy: DeviceAssignPolicy;
  shared_workspace_ids: string[];
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

// Column list backing RunnerHostRow queries (the token hash is included so control-channel auth
// can look a host up by it; strip it before anything reaches a client — see toRunnerHost).
const HOST_COLUMNS = `id, owner_uid, name, hostname, platform, arch, runner_version,
                      device_token_hash, assign_policy, shared_workspace_ids,
                      created_at, last_seen_at, revoked_at`;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Short, human-typable, unambiguous device code (no O/0/I/1). Displayed/typed as XXXX-XXXX.
export function genUserCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (const b of randomBytes(8)) s += alphabet[b % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

// --- Device-code auth flow ---

export interface DeviceAuthRow {
  device_code: string;
  user_code: string;
  created_at: string;
  expires_at: string;
  approved_uid: string | null;
  approved_at: string | null;
  host_id: string | null;
  claimed_at: string | null;
}

// Start a device-auth request. Returns the opaque device_code (CLI polls with it) and the short
// user_code (shown to the human). TTL is generous enough to log in + approve.
export async function createDeviceAuth(ttlMs = 10 * 60_000): Promise<DeviceAuthRow> {
  const deviceCode = randomBytes(32).toString("hex");
  const userCode = genUserCode();
  const expiresAt = new Date(Date.now() + ttlMs);
  const { rows } = await pool.query<DeviceAuthRow>(
    `insert into device_auth_requests (device_code, user_code, expires_at)
     values ($1, $2, $3) returning *`,
    [deviceCode, userCode, expiresAt],
  );
  return rows[0];
}

export async function getDeviceAuthByUserCode(userCode: string): Promise<DeviceAuthRow | null> {
  const { rows } = await pool.query<DeviceAuthRow>(
    `select * from device_auth_requests where user_code = $1`,
    [userCode.toUpperCase()],
  );
  return rows[0] ?? null;
}

export async function getDeviceAuthByDeviceCode(deviceCode: string): Promise<DeviceAuthRow | null> {
  const { rows } = await pool.query<DeviceAuthRow>(
    `select * from device_auth_requests where device_code = $1`,
    [deviceCode],
  );
  return rows[0] ?? null;
}

export function deviceAuthIsLive(row: DeviceAuthRow): boolean {
  if (row.claimed_at) return false;
  return new Date(row.expires_at).getTime() > Date.now();
}

// Bind a signed-in account to a pending request (the web "approve" step). No-op if already
// approved/claimed. Returns true if this call approved it.
export async function approveDeviceAuth(userCode: string, uid: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update device_auth_requests set approved_uid = $2, approved_at = now()
     where user_code = $1 and approved_uid is null and claimed_at is null
       and expires_at > now()`,
    [userCode.toUpperCase(), uid],
  );
  return (rowCount ?? 0) > 0;
}

// --- Hosts ---

// Exchange an approved device-auth request for a durable device token, creating the host row.
// Atomic + single-use: marks the request claimed and links it to the new host. Returns the host
// plus the RAW token (shown once; only its hash is stored). Throws if not approved/expired/claimed.
export async function claimDeviceAuth(
  deviceCode: string,
  info: { name: string; hostname: string; platform: string; arch: string; runnerVersion: string },
): Promise<{ host: RunnerHostRow; token: string }> {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  return withTransaction(async (client) => {
    // Lock the request row; validate it's approved, live, unclaimed.
    const { rows: reqRows } = await client.query<DeviceAuthRow>(
      `select * from device_auth_requests where device_code = $1 for update`,
      [deviceCode],
    );
    const req = reqRows[0];
    if (!req) throw new Error("unknown device code");
    if (req.claimed_at) throw new Error("device code already used");
    if (!req.approved_uid) throw new Error("not yet approved");
    if (new Date(req.expires_at).getTime() <= Date.now()) throw new Error("device code expired");
    const { rows: hostRows } = await client.query<RunnerHostRow>(
      `insert into runner_hosts (owner_uid, name, hostname, platform, arch, runner_version, device_token_hash)
       values ($1, $2, $3, $4, $5, $6, $7) returning ${HOST_COLUMNS}`,
      [req.approved_uid, info.name, info.hostname, info.platform, info.arch, info.runnerVersion, tokenHash],
    );
    const host = hostRows[0];
    await client.query(
      `update device_auth_requests set claimed_at = now(), host_id = $2 where device_code = $1`,
      [deviceCode, host.id],
    );
    return { host, token };
  });
}

// Authenticate a host-control connection: the live (non-revoked) host for a device token.
export async function getHostByToken(token: string): Promise<RunnerHostRow | null> {
  if (!token) return null;
  const { rows } = await pool.query<RunnerHostRow>(
    `select ${HOST_COLUMNS} from runner_hosts where device_token_hash = $1 and revoked_at is null`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

export async function getHost(id: string): Promise<RunnerHostRow | null> {
  const { rows } = await pool.query<RunnerHostRow>(
    `select ${HOST_COLUMNS} from runner_hosts where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// A device by id, but only if it's live and owned by `uid` — the ownership guard for
// rename/policy/revoke routes.
export async function getOwnedHost(id: string, uid: string): Promise<RunnerHostRow | null> {
  const { rows } = await pool.query<RunnerHostRow>(
    `select ${HOST_COLUMNS} from runner_hosts where id = $1 and owner_uid = $2 and revoked_at is null`,
    [id, uid],
  );
  return rows[0] ?? null;
}

// A signed-in account's live devices, newest first (the Environments page).
export async function listHostsByOwner(uid: string): Promise<RunnerHostRow[]> {
  const { rows } = await pool.query<RunnerHostRow>(
    `select ${HOST_COLUMNS} from runner_hosts
     where owner_uid = $1 and revoked_at is null order by created_at desc`,
    [uid],
  );
  return rows;
}

// The devices a requester may assign an agent to when creating it in `workspaceId`: their own
// devices, plus devices explicitly shared into this workspace under the workspace_members policy.
export async function assignableHosts(uid: string, workspaceId: string): Promise<RunnerHostRow[]> {
  const { rows } = await pool.query<RunnerHostRow>(
    `select ${HOST_COLUMNS} from runner_hosts
     where revoked_at is null
       and (owner_uid = $1
            or (assign_policy = 'workspace_members' and $2 = any(shared_workspace_ids)))
     order by created_at desc`,
    [uid, workspaceId],
  );
  return rows;
}

// Whether `uid` may assign an agent (being created in `workspaceId`) to host `hostId`.
export async function canAssignHost(hostId: string, uid: string, workspaceId: string): Promise<boolean> {
  const host = await getHost(hostId);
  if (!host || host.revoked_at) return false;
  if (host.owner_uid === uid) return true;
  return host.assign_policy === "workspace_members" && host.shared_workspace_ids.includes(workspaceId);
}

export async function updateHost(
  id: string,
  patch: { name?: string; assignPolicy?: DeviceAssignPolicy; sharedWorkspaceIds?: string[] },
): Promise<void> {
  await pool.query(
    `update runner_hosts set
       name = coalesce($2, name),
       assign_policy = coalesce($3, assign_policy),
       shared_workspace_ids = coalesce($4, shared_workspace_ids)
     where id = $1`,
    [id, patch.name ?? null, patch.assignPolicy ?? null, patch.sharedWorkspaceIds ?? null],
  );
}

// Record host info reported in the control-channel `host_hello` (host details can change between
// registration and later reconnects — e.g. an OS upgrade, or a rename via `hostname`).
export async function updateHostInfo(
  id: string,
  info: { hostname: string; platform: string; arch: string; runnerVersion: string },
): Promise<void> {
  await pool.query(
    `update runner_hosts set hostname = $2, platform = $3, arch = $4, runner_version = $5,
       last_seen_at = now() where id = $1`,
    [id, info.hostname, info.platform, info.arch, info.runnerVersion],
  );
}

export async function touchHostSeen(id: string): Promise<void> {
  await pool.query(`update runner_hosts set last_seen_at = now() where id = $1`, [id]);
}

// Soft-delete a device (revoke its token → the control channel rejects it and its daemon exits).
// Ownership-checked by the caller (getOwnedHost). Returns true if one was revoked.
export async function revokeHost(id: string, uid: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update runner_hosts set revoked_at = now() where id = $1 and owner_uid = $2 and revoked_at is null`,
    [id, uid],
  );
  return (rowCount ?? 0) > 0;
}

// Agents currently assigned to a device (runner_meta.hostId = id). Used to warn on revoke and to
// reconcile which agents the daemon should be running. Returns minimal shape for lifecycle use.
export async function agentsOnHost(hostId: string): Promise<{ id: string; handle: string; runner_token: string | null }[]> {
  const { rows } = await pool.query<{ id: string; handle: string; runner_token: string | null }>(
    `select id, handle, runner_token from participants
     where kind = 'agent' and runner_provider = 'self_hosted' and runner_meta->>'hostId' = $1`,
    [hostId],
  );
  return rows;
}
