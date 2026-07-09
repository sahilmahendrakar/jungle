import { Router } from "express";
import { supportsUnsandboxed, type RunnerHost, type DeviceAssignPolicy } from "@jungle/shared";
import * as db from "../../db";
import * as runners from "../../runners";
import * as hostcontrol from "../../hostcontrol";
import { selfHostedEndpoints } from "../../provisioner";
import { broadcastUid } from "../../ws/appSocket";
import { wrap, ApiError } from "../errors";
import { reqString, optString } from "../validate";
import { requireRequester, accountUid } from "../guards";

// Self-hosted devices. Two audiences use this router:
//   • the web app (authenticated): device-code approval, and listing/renaming/removing devices;
//   • a machine's `jungle-agents` CLI (unauthenticated, code-gated): starting a device-code
//     request and polling to exchange it for a durable device token.
// A device is account-scoped (owner = accountUid). See db/hosts.ts + shared/src/host-protocol.ts.

const router = Router();

// Where the CLI tells the user to go to approve (the web /link page). Overridable per deploy.
const VERIFICATION_URI = (process.env.FRONTEND_URL ?? "https://jungleagents.com").replace(/\/$/, "") + "/link";

// Serialize a device row for clients: strip the token hash, add derived online + running-agent
// count (from the live host-control connection + per-agent runner sockets).
function toRunnerHost(row: db.RunnerHostRow, runningAgents: number): RunnerHost {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    platform: row.platform,
    arch: row.arch,
    runner_version: row.runner_version,
    assign_policy: row.assign_policy,
    shared_workspace_ids: row.shared_workspace_ids,
    sandboxed: row.sandboxed,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    online: hostcontrol.isHostOnline(row.id),
    running_agents: runningAgents,
  };
}

async function serializeHost(row: db.RunnerHostRow): Promise<RunnerHost> {
  const agents = await db.agentsOnHost(row.id);
  const running = agents.filter((a) => runners.isConnected(a.id)).length;
  return toRunnerHost(row, running);
}

// --- Device-code auth flow (CLI: start + poll; web: approve) ---

// CLI step 1: begin a device-code request. Unauthenticated — the token isn't issued until a
// signed-in user approves the user_code.
router.post(
  "/api/devices/auth/start",
  wrap(async (_req, res) => {
    const row = await db.createDeviceAuth();
    res.status(201).json({
      deviceCode: row.device_code,
      userCode: row.user_code,
      verificationUri: VERIFICATION_URI,
      verificationUriComplete: `${VERIFICATION_URI}?code=${encodeURIComponent(row.user_code)}`,
      expiresAt: row.expires_at,
      interval: 3, // suggested poll seconds
    });
  }),
);

// Web preview: does this user_code name a live, unapproved request? Drives the /link confirm page.
router.get(
  "/api/devices/auth/:userCode",
  wrap(async (req, res) => {
    await requireRequester(req); // must be signed in to see/approve
    const row = await db.getDeviceAuthByUserCode(String(req.params.userCode));
    res.json({ valid: !!row && db.deviceAuthIsLive(row) && !row.approved_uid });
  }),
);

// Web step 2: a signed-in user approves a user_code shown on their machine. Binds the request to
// this account; the CLI's next poll then gets a token registered to this account.
router.post(
  "/api/devices/auth/approve",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const userCode = reqString(req.body?.userCode, "userCode");
    const ok = await db.approveDeviceAuth(userCode, accountUid(me));
    if (!ok) throw new ApiError(400, "that code is invalid, already used, or expired");
    res.json({ ok: true });
  }),
);

// CLI step 3: poll to exchange an approved device_code for a durable device token. Also registers
// the runner_hosts row (from the CLI-supplied machine details) on success. 202 while still pending.
router.post(
  "/api/devices/auth/token",
  wrap(async (req, res) => {
    const deviceCode = reqString(req.body?.deviceCode, "deviceCode");
    const row = await db.getDeviceAuthByDeviceCode(deviceCode);
    if (!row) throw new ApiError(400, "unknown device code");
    if (row.claimed_at) throw new ApiError(400, "device code already used");
    if (!db.deviceAuthIsLive(row)) throw new ApiError(400, "device code expired");
    if (!row.approved_uid) {
      res.status(202).json({ status: "authorization_pending" });
      return;
    }
    const hostname = optString(req.body?.hostname) ?? "unknown-host";
    const { host, token } = await db.claimDeviceAuth(deviceCode, {
      name: optString(req.body?.name) ?? hostname,
      hostname,
      platform: optString(req.body?.platform) ?? "unknown",
      arch: optString(req.body?.arch) ?? "unknown",
      runnerVersion: optString(req.body?.runnerVersion) ?? "unknown",
    });
    const { backendWs, llmBaseUrl } = selfHostedEndpoints();
    // Tell the owner's open web app a new device just came online.
    broadcastUid(host.owner_uid, { type: "device_status_changed", deviceId: host.id, online: false });
    res.json({
      status: "ok",
      deviceToken: token, // shown once; only its hash is stored
      device: { id: host.id, name: host.name },
      controlWs: `${backendWs.replace(/\/api\/runner$/, "")}/api/host`,
      backendWs,
      llmBaseUrl,
    });
  }),
);

// --- Device management (web, authenticated) ---

// List the signed-in account's devices (the Environments page).
router.get(
  "/api/devices",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const rows = await db.listHostsByOwner(accountUid(me));
    res.json(await Promise.all(rows.map(serializeHost)));
  }),
);

// Rename a device or change its assign policy / shared workspaces (owner only).
router.patch(
  "/api/devices/:id",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const host = await db.getOwnedHost(String(req.params.id), accountUid(me));
    if (!host) throw new ApiError(404, "device not found");
    const patch: {
      name?: string;
      assignPolicy?: DeviceAssignPolicy;
      sharedWorkspaceIds?: string[];
      sandboxed?: boolean;
    } = {};
    if (req.body?.name !== undefined) patch.name = reqString(req.body.name, "name");
    if (req.body?.assignPolicy !== undefined) {
      const p = String(req.body.assignPolicy);
      if (p !== "owner_only" && p !== "workspace_members") throw new ApiError(400, "invalid assignPolicy");
      patch.assignPolicy = p;
    }
    if (req.body?.sharedWorkspaceIds !== undefined) {
      if (!Array.isArray(req.body.sharedWorkspaceIds)) throw new ApiError(400, "sharedWorkspaceIds must be an array");
      patch.sharedWorkspaceIds = req.body.sharedWorkspaceIds.map(String);
    }
    if (req.body?.sandboxed !== undefined) {
      patch.sandboxed = Boolean(req.body.sandboxed);
      // Block flipping a device to unsandboxed when we KNOW its CLI is too old to honor it. The
      // runtime provisioner also downgrades as a safety net, but rejecting here makes the
      // requirement visible at toggle time. A null runner_version (never connected / unknown) is
      // allowed through — the device may update and reconnect before any agent runs.
      if (patch.sandboxed === false && !supportsUnsandboxed(host.runner_version)) {
        throw new ApiError(
          400,
          `This device's CLI (version ${host.runner_version ?? "unknown"}) is too old to run ` +
            `unsandboxed. Update it on the device with \`npx jungle-agents@latest up\`, then try again.`,
        );
      }
    }
    await db.updateHost(host.id, patch);
    const updated = await db.getHost(host.id);
    res.json(updated ? await serializeHost(updated) : null);
  }),
);

// Remove a device: revoke its token (its daemon can no longer connect) and force-drop any live
// control connection. Agents assigned to it stay in the workspace but go offline until reassigned.
router.delete(
  "/api/devices/:id",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const host = await db.getOwnedHost(String(req.params.id), accountUid(me));
    if (!host) throw new ApiError(404, "device not found");
    await db.revokeHost(host.id, accountUid(me));
    hostcontrol.disconnectHost(host.id);
    // The device's agents just lost their runner; re-emit their status (now offline).
    for (const a of await db.agentsOnHost(host.id)) runners.refreshStatus(a.id);
    res.json({ ok: true });
  }),
);

export default router;
