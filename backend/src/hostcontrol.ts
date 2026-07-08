import "./env";
import type { IncomingMessage } from "node:http";
import type internal from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { HostToBackend, BackendToHost } from "@jungle/shared";
import * as db from "./db";

// The host-control side of self-hosted devices. A user's `jungle-runner` DAEMON dials INTO the
// backend at GET /api/host?token=<device_token> (WS upgrade) and speaks
// shared/src/host-protocol.ts. Over this one connection per device the backend tells the daemon
// which agents to run (`run_agent`/`stop_agent`/`remove_agent`); the daemon spawns/kills per-agent
// runner children that dial /api/runner exactly like cloud runners.
//
// This module owns: the /api/host WS upgrade + device-token auth, the per-device connection
// registry, and the agentId->hostId map that lets runners.agentStatus() synchronously tell
// "offline" (device down) from "sleeping" (device up, agent idle-stopped). The chat/status
// side-effects it triggers (broadcasting device_status, re-emitting agent status, waking pending
// work) live in index.ts and are injected via init() to avoid an import cycle.

interface HostConn {
  hostId: string;
  ownerUid: string;
  ws: WebSocket;
  running: Set<string>; // agentIds the daemon reports it currently has a runner child for
}

// hostId -> the single live control connection (a new connect replaces the old).
const hostConns = new Map<string, HostConn>();

// agentId -> the device it's assigned to, mirrored from participants.runner_meta.hostId. Kept in
// memory (seeded at boot, updated by the SelfHostedProvisioner) so status derivation stays sync.
const agentHost = new Map<string, string>();

export function isHostOnline(hostId: string | null | undefined): boolean {
  return !!hostId && hostConns.has(hostId);
}

export function hostForAgent(agentId: string): string | undefined {
  return agentHost.get(agentId);
}

// True only for a self-hosted agent whose assigned device is currently disconnected. runners.ts
// uses this to surface the `offline` status (backend can't wake the device — work just queues).
export function isAgentDeviceOffline(agentId: string): boolean {
  const h = agentHost.get(agentId);
  return !!h && !hostConns.has(h);
}

// True if the agent is self-hosted AND its device is connected — the gate for lifecycle actions
// (idle-stop, wake-on-message): we can only start/stop a child when the daemon is reachable.
export function isAgentDeviceOnline(agentId: string): boolean {
  const h = agentHost.get(agentId);
  return !!h && hostConns.has(h);
}

// Whether we track a device for this agent at all (i.e. it's a self-hosted agent).
export function agentIsSelfHosted(agentId: string): boolean {
  return agentHost.has(agentId);
}

// Whether the agent's device reports it as currently running a runner child (from host_hello /
// run/stop bookkeeping). Used by SelfHostedProvisioner.status() at boot reconcile.
export function isRunningOnDevice(agentId: string): boolean {
  const h = agentHost.get(agentId);
  if (!h) return false;
  const c = hostConns.get(h);
  return !!c && c.running.has(agentId);
}

export function setAgentHost(agentId: string, hostId: string): void {
  agentHost.set(agentId, hostId);
}
export function clearAgentHost(agentId: string): void {
  agentHost.delete(agentId);
}

// Seed the agentId->hostId map at boot from the self-hosted agents in the DB.
export function seedAgentHost(agentId: string, hostId: string): void {
  agentHost.set(agentId, hostId);
}

// Send a control frame to a device. Returns false if the device isn't connected (caller decides
// whether that's fine — for start(), an offline device just means the work waits).
export function sendToHost(hostId: string, frame: BackendToHost): boolean {
  const c = hostConns.get(hostId);
  if (!c || c.ws.readyState !== WebSocket.OPEN) return false;
  c.ws.send(JSON.stringify(frame));
  return true;
}

// Force-drop a device's control connection (its token was revoked / device removed). Closing with
// 4003 tells the daemon to stop rather than reconnect. No-op if it isn't connected.
export function disconnectHost(hostId: string): void {
  const c = hostConns.get(hostId);
  if (!c) return;
  hostConns.delete(hostId);
  try {
    c.ws.close(4003, "device removed");
  } catch {
    /* already closing */
  }
}

// --- Injected side-effects (wired by index.ts) ---

export interface HostControlHooks {
  // A device's control connection came up (online=true, after its host_hello) or went down
  // (online=false). index.ts broadcasts device_status to the owner's sockets, re-emits status for
  // every agent on the device (offline <-> sleeping/idle), and on `online` kicks pending work.
  onHostStatusChange: (hostId: string, ownerUid: string, online: boolean) => void;
}

let hooks: HostControlHooks | null = null;

// --- WS upgrade + protocol handling ---

async function accept(ws: WebSocket, token: string): Promise<void> {
  // Attach the message listener SYNCHRONOUSLY before any await — the daemon sends `host_hello`
  // the instant the socket opens (same gotcha as runners.accept). Buffer early frames, then
  // replay once auth+registration completes.
  let conn: HostConn | null = null;
  const early: string[] = [];
  ws.on("message", (raw) => {
    if (conn) void handleHostFrame(conn, raw.toString());
    else early.push(raw.toString());
  });
  ws.on("error", (e) => console.error("host socket error (pre-auth):", e));

  const host = await db.getHostByToken(token);
  if (!host) {
    ws.close(4001, "invalid device token");
    return;
  }
  // One live control conn per device: a new connection replaces the old.
  const existing = hostConns.get(host.id);
  if (existing && existing.ws !== ws) {
    try {
      existing.ws.close(4000, "replaced by new connection");
    } catch {
      /* ignore */
    }
  }
  conn = { hostId: host.id, ownerUid: host.owner_uid, ws, running: new Set() };
  hostConns.set(host.id, conn);
  await db.touchHostSeen(host.id);
  console.log(`host[${host.id}] (${host.name}) connected`);

  ws.on("close", () => {
    if (hostConns.get(host.id) === conn) {
      hostConns.delete(host.id);
      void db.touchHostSeen(host.id);
      // The device is gone: its per-agent runner children died with it, but emit explicitly so any
      // agent whose /api/runner close raced ahead of this settles on `offline`.
      hooks?.onHostStatusChange(host.id, host.owner_uid, false);
      console.log(`host[${host.id}] disconnected`);
    }
  });

  for (const raw of early) void handleHostFrame(conn, raw);
}

async function handleHostFrame(conn: HostConn, raw: string): Promise<void> {
  let frame: HostToBackend;
  try {
    frame = JSON.parse(raw) as HostToBackend;
  } catch {
    return;
  }
  try {
    switch (frame.type) {
      case "host_hello": {
        // Record possibly-changed host details + what the daemon says it's running.
        await db.updateHostInfo(conn.hostId, {
          hostname: frame.hostname,
          platform: frame.platform,
          arch: frame.arch,
          runnerVersion: frame.runnerVersion,
        });
        conn.running = new Set(Array.isArray(frame.running) ? frame.running : []);
        // Now that the device is really up (and we know what it's running), flip it online:
        // broadcast device_status, re-emit agent statuses, and wake any agent with queued work.
        hooks?.onHostStatusChange(conn.hostId, conn.ownerUid, true);
        break;
      }
      case "runner_exited": {
        conn.running.delete(frame.agentId);
        // The child's /api/runner socket close already re-derived the agent's status; nothing to do
        // here beyond bookkeeping. If it exited with pending work, the idle-stop sweeper's reverse
        // path re-issues run_agent while the device stays online.
        break;
      }
      case "host_heartbeat": {
        await db.touchHostSeen(conn.hostId);
        break;
      }
      default:
        console.warn(`host[${conn.hostId}] unknown frame:`, (frame as HostToBackend).type);
    }
  } catch (e) {
    console.error(`host[${conn.hostId}] error handling ${(frame as HostToBackend).type}:`, e);
  }
}

// Wire the host-control subsystem into the HTTP/WS server. Handles the `upgrade` for /api/host,
// leaving every other path (the app WSS, /api/runner) untouched. Call once at boot.
export function init(server: import("node:http").Server, h: HostControlHooks): void {
  hooks = h;
  const hwss = new WebSocketServer({ noServer: true });
  hwss.on("connection", (ws: WebSocket, _req: IncomingMessage, token: string) => {
    void accept(ws, token);
  });
  server.on("upgrade", (req: IncomingMessage, socket: internal.Duplex, head: Buffer) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return;
    }
    if (pathname !== "/api/host") return; // not ours — runners.ts / the app WSS handle their paths
    const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
    hwss.handleUpgrade(req, socket, head, (ws) => hwss.emit("connection", ws, req, token));
  });
}
