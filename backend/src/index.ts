import "./env";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import * as db from "./db";
import * as ma from "./ma";

const app = express();
app.use(express.json());

// MVP CORS: the frontend (a different origin in dev) needs to read API responses.
// Lock the origin down before any real deployment.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "content-type");
  res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

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

// Create an agent = one MA session + a participant of kind 'agent'.
app.post("/api/agents", async (req, res) => {
  try {
    const { handle, displayName } = req.body ?? {};
    if (!handle || !displayName) {
      return res.status(400).json({ error: "handle, displayName required" });
    }
    const maSessionId = await ma.createAgentSession(`jungle agent @${handle}`);
    res.status(201).json(await db.createParticipant({ kind: "agent", handle, displayName, maSessionId }));
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

app.get("/api/channels", async (req, res) => {
  try {
    const participantId = (req.query.participantId as string | undefined) || undefined;
    res.json(await db.listChannels(participantId));
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

// A human message starts a cascade with this budget; each agent->agent hop decrements
// it. At 0, agents stop auto-replying until a human speaks again. Bounds loops + cost.
const DEFAULT_CASCADE_BUDGET = 3;

// If a message addresses an agent (via @mention, or by being the other member of a DM),
// run that agent's turn and post its reply back. Async / fire-and-forget so posting stays
// fast. The reply itself re-enters this function (agent->agent), gated by cascade_budget.
async function triggerMentionedAgents(channelId: string, message: db.PersistedMessage) {
  try {
    const budget = message.cascade_budget ?? 0;
    if (budget <= 0) return; // cascade exhausted — wait for a human to speak again
    const channel = await db.getChannel(channelId);
    if (!channel) return;
    let candidateIds = message.mentions.map((m) => m.id);
    if (channel.kind === "dm" && !candidateIds.length) {
      candidateIds = await db.channelMemberIds(channelId);
    }
    candidateIds = candidateIds.filter((id) => id !== message.sender_id); // never self-trigger
    const agents = await db.agentsByIds(candidateIds);
    for (const agent of agents) void runAgentReply(channelId, channel.name, agent, budget - 1);
  } catch (e) {
    console.error("triggerMentionedAgents:", e);
  }
}

async function runAgentReply(
  channelId: string,
  channelName: string,
  agent: { id: string; handle: string; ma_session_id: string },
  replyBudget: number,
) {
  try {
    const context = await db.getRecentContext(channelId, 20);
    const input =
      `You are @${agent.handle} in the #${channelName} channel of a Slack-like app. ` +
      `Here is the recent conversation:\n\n${context}\n\n` +
      `Reply to the most recent message addressed to you. Keep it brief and conversational. ` +
      `You may address another participant by writing @their_handle.`;
    const reply = await ma.runAgentTurn(agent.ma_session_id, input);
    if (reply.trim()) {
      const msg = await db.persistMessage({
        channelId,
        senderId: agent.id,
        body: reply,
        cascadeBudget: replyBudget,
      });
      await fanOut(channelId, { type: "message", message: msg });
      void triggerMentionedAgents(channelId, msg); // the reply may address another agent
    }
  } catch (e) {
    console.error("runAgentReply:", e);
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
          cascadeBudget: DEFAULT_CASCADE_BUDGET, // human messages start a fresh cascade
        });
        await fanOut(evt.channelId, { type: "message", message });
        void triggerMentionedAgents(evt.channelId, message);
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", error: String((e as Error).message ?? e) }));
      }
    }
  });

  ws.on("close", () => removeSocket(participantId, ws));
});

const PORT = Number(process.env.PORT ?? 3001);
server.listen(PORT, () => console.log(`jungle-backend on http://localhost:${PORT}`));
