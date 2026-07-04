import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import * as db from "../db";
import type { PersistedMessage } from "../db";
import * as auth from "../auth";
import * as att from "../attachments";

// The app (human/device) WebSocket: realtime message delivery to browsers. Distinct from the
// runner subsystem (runners.ts), which owns the /api/runner upgrade path. This module owns the
// socket registry and the two fan-out primitives used across the backend.

// A human message starts a cascade with this budget; each agent->agent hop decrements it. At 0,
// agents stop auto-replying until a human speaks again. Bounds loops + cost.
export const DEFAULT_CASCADE_BUDGET = 3;

// participantId -> open sockets (a participant may be connected from several devices).
const sockets = new Map<string, Set<WebSocket>>();

function addSocket(pid: string, ws: WebSocket): void {
  let set = sockets.get(pid);
  if (!set) sockets.set(pid, (set = new Set()));
  set.add(ws);
}
function removeSocket(pid: string, ws: WebSocket): void {
  const set = sockets.get(pid);
  if (set) {
    set.delete(ws);
    if (!set.size) sockets.delete(pid);
  }
}

// Fan out a payload to every connected device of every member of a channel.
export async function fanOut(channelId: string, payload: unknown): Promise<void> {
  const data = JSON.stringify(payload);
  for (const pid of await db.channelMemberIds(channelId)) {
    const set = sockets.get(pid);
    if (set) for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// Broadcast to every connected socket (workspace-wide events, e.g. a participant's profile
// changed — everyone's People list / open profile should reflect it).
export function broadcastAll(payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const set of sockets.values()) {
    for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
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
    if (pathname === "/api/runner") return; // handled by runners.init's own upgrade listener
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Real auth: a Firebase ID token (?token=) is verified and mapped to the user's participant.
    // Dev/test: when DEV_BYPASS is on, fall back to a trusted ?participantId=.
    let participantId: string | null = null;
    const token = url.searchParams.get("token");
    if (token && auth.firebaseConfigured()) {
      try {
        const u = await auth.verifyIdToken(token);
        participantId = (await db.getParticipantByFirebaseUid(u.uid))?.id ?? null;
      } catch {
        /* invalid token — fall through to (possible) dev bypass / reject */
      }
    }
    if (!participantId && auth.DEV_BYPASS) {
      participantId = url.searchParams.get("participantId");
    }
    if (!participantId) {
      ws.close(4001, "auth required");
      return;
    }
    const pid = participantId;
    addSocket(pid, ws);
    ws.send(JSON.stringify({ type: "connected", participantId: pid }));

    ws.on("message", async (raw) => {
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
    });

    ws.on("close", () => removeSocket(pid, ws));
  });
}
