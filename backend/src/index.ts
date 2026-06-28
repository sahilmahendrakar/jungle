import "./env";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import * as db from "./db";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "jungle-backend" });
});

// --- REST: setup + history (used by the test now, the frontend later) ---

app.post("/api/participants", async (req, res) => {
  try {
    const { kind, handle, displayName, maSessionId } = req.body ?? {};
    if (!kind || !handle || !displayName) {
      return res.status(400).json({ error: "kind, handle, displayName required" });
    }
    res.status(201).json(await db.createParticipant({ kind, handle, displayName, maSessionId }));
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

app.post("/api/channels", async (req, res) => {
  try {
    const { name, kind, memberHandles } = req.body ?? {};
    if (!name || !kind) return res.status(400).json({ error: "name, kind required" });
    res.status(201).json(await db.createChannel({ name, kind, memberHandles: memberHandles ?? [] }));
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

app.get("/api/channels/:id/messages", async (req, res) => {
  try {
    const afterSeq = Number(req.query.afterSeq ?? 0);
    res.json(await db.getMessages(req.params.id, afterSeq));
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// --- WebSocket: realtime messaging ---

const server = createServer(app);
const wss = new WebSocketServer({ server });

// participantId -> open sockets (a participant may be connected from several devices)
const sockets = new Map<string, Set<WebSocket>>();

function addSocket(pid: string, ws: WebSocket) {
  let set = sockets.get(pid);
  if (!set) sockets.set(pid, (set = new Set()));
  set.add(ws);
}
function removeSocket(pid: string, ws: WebSocket) {
  const set = sockets.get(pid);
  if (set) {
    set.delete(ws);
    if (!set.size) sockets.delete(pid);
  }
}

// Fan out a payload to every connected device of every member of a channel.
async function fanOut(channelId: string, payload: unknown) {
  const data = JSON.stringify(payload);
  for (const pid of await db.channelMemberIds(channelId)) {
    const set = sockets.get(pid);
    if (set) for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const participantId = url.searchParams.get("participantId");
  if (!participantId) {
    ws.close(4001, "participantId required");
    return;
  }
  addSocket(participantId, ws);
  ws.send(JSON.stringify({ type: "connected", participantId }));

  ws.on("message", async (raw) => {
    let evt: { type?: string; channelId?: string; body?: string; clientMsgId?: string };
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // The one routing rule (human-only for now): persist -> fan out.
    if (evt.type === "post" && evt.channelId && evt.body) {
      try {
        if (!(await db.isMember(evt.channelId, participantId))) {
          ws.send(JSON.stringify({ type: "error", error: "not a member of channel" }));
          return;
        }
        const message = await db.persistMessage({
          channelId: evt.channelId,
          senderId: participantId,
          body: evt.body,
          clientMsgId: evt.clientMsgId ?? null,
        });
        await fanOut(evt.channelId, { type: "message", message });
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", error: String((e as Error).message ?? e) }));
      }
    }
  });

  ws.on("close", () => removeSocket(participantId, ws));
});

const PORT = Number(process.env.PORT ?? 3001);
server.listen(PORT, () => console.log(`jungle-backend on http://localhost:${PORT}`));
