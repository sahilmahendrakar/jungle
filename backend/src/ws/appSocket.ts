import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import * as db from "../db";
import type { PersistedMessage } from "../db";
import * as auth from "../auth";
import * as att from "../attachments";
import * as push from "../services/push";

// The app (human/device) WebSocket: realtime message delivery to browsers. Distinct from the
// runner subsystem (runners.ts), which owns the /api/runner upgrade path. This module owns the
// socket registry and the two fan-out primitives used across the backend.

// A human message starts a cascade with this budget; each agent->agent hop decrements it. At 0,
// agents stop auto-replying until a human speaks again. Bounds loops + cost.
export const DEFAULT_CASCADE_BUDGET = 3;

// participantId -> open sockets (a participant may be connected from several devices).
const sockets = new Map<string, Set<WebSocket>>();
// workspaceId -> open sockets in that workspace (for workspace-scoped broadcasts). A socket lives
// in exactly one workspace (the participant it authenticated as belongs to one workspace).
const workspaceSockets = new Map<string, Set<WebSocket>>();
// firebaseUid -> open sockets across ALL that account's workspaces (for account-scoped events like
// self-hosted device status, since a device belongs to an account, not a single workspace).
const uidSockets = new Map<string, Set<WebSocket>>();

function addToMap(map: Map<string, Set<WebSocket>>, key: string, ws: WebSocket): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(ws);
}
function removeFromMap(map: Map<string, Set<WebSocket>>, key: string, ws: WebSocket): void {
  const set = map.get(key);
  if (set) {
    set.delete(ws);
    if (!set.size) map.delete(key);
  }
}

function addSocket(pid: string, workspaceId: string, uid: string | null, ws: WebSocket): void {
  addToMap(sockets, pid, ws);
  addToMap(workspaceSockets, workspaceId, ws);
  if (uid) addToMap(uidSockets, uid, ws);
}
function removeSocket(pid: string, workspaceId: string, uid: string | null, ws: WebSocket): void {
  removeFromMap(sockets, pid, ws);
  removeFromMap(workspaceSockets, workspaceId, ws);
  if (uid) removeFromMap(uidSockets, uid, ws);
}

// Fan out a payload to every connected device of every member of a channel. Channel-scoped
// events also drive mobile push (fire-and-forget): DMs/mentions on `message`, and
// tool_confirmation_request to every human member — suppressed for anyone with a live socket
// (the in-app UI already carries the signal).
export async function fanOut(channelId: string, payload: unknown): Promise<void> {
  const data = JSON.stringify(payload);
  const memberIds = await db.channelMemberIds(channelId);
  for (const pid of memberIds) {
    const set = sockets.get(pid);
    if (set) for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
  pushForFanOut(channelId, memberIds, payload).catch((e) =>
    console.error("push fan-out failed:", String((e as Error).message ?? e)),
  );
}

// Decide who (if anyone) gets a mobile push for a channel-scoped event.
async function pushForFanOut(channelId: string, memberIds: string[], payload: unknown): Promise<void> {
  const evt = payload as {
    type?: string;
    message?: PersistedMessage & { mentions?: { id: string }[] };
    confirmId?: string;
    agentHandle?: string;
    tool?: string;
  };
  if (evt.type !== "message" && evt.type !== "tool_confirmation_request") return;

  // A recipient with ANY open socket is looking at the app — no push.
  const offline = (pid: string) => {
    const set = sockets.get(pid);
    return !set || ![...set].some((ws) => ws.readyState === WebSocket.OPEN);
  };

  const channel = await db.getChannel(channelId);
  if (!channel) return;

  if (evt.type === "message" && evt.message) {
    const m = evt.message;
    const mentioned = new Set((m.mentions ?? []).map((x) => x.id));
    const isDM = channel.kind === "dm";
    const uids: string[] = [];
    for (const pid of memberIds) {
      if (pid === m.sender_id) continue;
      if (!isDM && !mentioned.has(pid)) continue;
      if (!offline(pid)) continue;
      const p = await db.getParticipant(pid);
      if (p?.kind === "human" && p.firebase_uid) uids.push(p.firebase_uid);
    }
    if (!uids.length) return;
    const title = isDM ? `@${m.sender_handle}` : `@${m.sender_handle} in #${channel.name}`;
    await push.sendPush(uids, {
      title,
      body: push.preview(m.body || "sent an attachment"),
      threadId: channelId,
      data: {
        kind: "message",
        workspaceId: channel.workspace_id,
        channelId,
        ...(m.thread_root_id ? { threadRootId: m.thread_root_id } : {}),
      },
    });
    return;
  }

  if (evt.type === "tool_confirmation_request" && evt.confirmId) {
    const uids: string[] = [];
    for (const pid of memberIds) {
      if (!offline(pid)) continue;
      const p = await db.getParticipant(pid);
      if (p?.kind === "human" && p.firebase_uid) uids.push(p.firebase_uid);
    }
    if (!uids.length) return;
    await push.sendPush(uids, {
      title: `@${evt.agentHandle ?? "agent"} needs approval`,
      body: `Wants to run ${evt.tool ?? "a tool"} — allow or deny`,
      category: "CONFIRM",
      threadId: channelId,
      data: {
        kind: "confirm",
        workspaceId: channel.workspace_id,
        channelId,
        confirmId: evt.confirmId,
      },
    });
  }
}

// Broadcast to every connected socket in ONE workspace (workspace-wide events, e.g. a
// participant's profile changed, or an agent's live status/activity — everyone in that workspace
// should see it, and NO ONE outside it). Replaces the old broadcast-to-all-tenants primitive.
export function broadcastWorkspace(workspaceId: string, payload: unknown): void {
  const set = workspaceSockets.get(workspaceId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

// Broadcast to every connected socket of ONE account (all workspaces), keyed by Firebase uid. For
// account-scoped events — self-hosted device status — that don't belong to any single workspace.
export function broadcastUid(uid: string, payload: unknown): void {
  const set = uidSockets.get(uid);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

// Effects the socket needs from the orchestration layer (injected to avoid a ws<->service
// import cycle): after a human's message is persisted + fanned out, run any addressed agents.
export interface AppSocketHooks {
  onMessagePosted: (channelId: string, message: PersistedMessage, senderKind: "human") => void;
}

// Attach the app WSS to the http server. We route upgrades ourselves: /api/runner goes to the
// runner subsystem (its own upgrade listener), everything else here.
export function initAppSocket(server: Server, hooks: AppSocketHooks): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      /* keep default */
    }
    // Handled by their own upgrade listeners (runners.init / hostcontrol.init).
    if (pathname === "/api/runner" || pathname === "/api/host") return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Frames can arrive the instant the socket opens — BEFORE the auth awaits below finish and
    // the real message listener attaches — and ws drops events with no listener. Buffer them now,
    // replay after setup. (Same lesson as the runner subsystem's synchronous accept().)
    const early: Buffer[] = [];
    const buffer = (raw: Buffer) => {
      early.push(raw);
    };
    ws.on("message", buffer);
    // Real auth: a Firebase ID token (?token=) is verified and mapped to the user's participant in
    // the active workspace (&workspaceId=, with a single-membership fallback during rollout).
    // Dev/test: when DEV_BYPASS is on, fall back to a trusted ?participantId=.
    let participant: db.Participant | null = null;
    const token = url.searchParams.get("token");
    if (token && auth.firebaseConfigured()) {
      try {
        const u = await auth.verifyIdToken(token);
        const wsId = url.searchParams.get("workspaceId");
        participant = wsId
          ? await db.getParticipantByUidAndWorkspace(u.uid, wsId)
          : (await db.listParticipantsByUid(u.uid))[0] ?? null;
      } catch {
        /* invalid token — fall through to (possible) dev bypass / reject */
      }
    }
    if (!participant && auth.DEV_BYPASS) {
      const pid = url.searchParams.get("participantId");
      if (pid) participant = await db.getParticipant(pid);
    }
    if (!participant) {
      ws.close(4001, "auth required");
      return;
    }
    const pid = participant.id;
    const workspaceId = participant.workspace_id;
    const uid = participant.firebase_uid;
    addSocket(pid, workspaceId, uid, ws);
    ws.send(JSON.stringify({ type: "connected", participantId: pid }));

    const onMessage = async (raw: Buffer) => {
      let evt: {
        type?: string;
        channelId?: string;
        body?: string;
        clientMsgId?: string;
        attachmentIds?: string[];
        threadRootId?: string | null;
        alsoToChannel?: boolean;
      };
      try {
        evt = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // The one routing rule (human-only for now): persist -> fan out. A post needs a body
      // and/or pre-uploaded attachments (POST /api/attachments). A post carrying threadRootId is
      // a thread reply (alsoToChannel echoes it into the main timeline too).
      const attachmentIds = (Array.isArray(evt.attachmentIds) ? evt.attachmentIds : [])
        .map(String)
        .slice(0, att.MAX_ATTACHMENTS_PER_MESSAGE);
      if (evt.type === "post" && evt.channelId && (evt.body || attachmentIds.length)) {
        try {
          if (!(await db.isMember(evt.channelId, pid))) {
            ws.send(JSON.stringify({ type: "error", error: "not a member of channel" }));
            return;
          }
          const message = await db.persistMessage({
            channelId: evt.channelId,
            senderId: pid,
            body: evt.body ?? "",
            clientMsgId: evt.clientMsgId ?? null,
            cascadeBudget: DEFAULT_CASCADE_BUDGET, // human messages start a fresh cascade
            attachmentIds,
            threadRootId: evt.threadRootId ?? null,
            alsoToChannel: !!evt.alsoToChannel,
          });
          await fanOut(evt.channelId, { type: "message", message: att.withUrls(message) });
          hooks.onMessagePosted(evt.channelId, message, "human");
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", error: String((e as Error).message ?? e) }));
        }
      }
    };
    ws.off("message", buffer);
    ws.on("message", (raw) => void onMessage(raw as Buffer));
    for (const raw of early) void onMessage(raw);

    ws.on("close", () => removeSocket(pid, workspaceId, uid, ws));
  });
}
