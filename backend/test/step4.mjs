// Step 4 verification: a human @mentions an agent; the agent's MA session runs a turn
// and its reply is posted back into the channel (fanned out + persisted). Exit 0 = PASS.
// Self-cleaning: deletes its DB rows and the MA session.
//
// Run:  set -a; . ~/.config/jungle/.env; set +a; node backend/test/step4.mjs
import { WebSocket } from "ws";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";

const BASE = "http://localhost:3001";
const WS = "ws://localhost:3001";
const sfx = Date.now().toString(36);
const human = `sahil_${sfx}`;
const agentHandle = `sage_${sfx}`;
const chanName = `step4_${sfx}`;

const post = (path, body) =>
  fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic();
let pass = false;
let channelId, humanId, agentId, maSessionId, ws;

try {
  const h = await post("/api/participants", { kind: "human", handle: human, displayName: "Sahil" });
  humanId = h.id;
  const agent = await post("/api/agents", { handle: agentHandle, displayName: "Sage" });
  agentId = agent.id;
  maSessionId = agent.ma_session_id;
  const chan = await post("/api/channels", { name: chanName, kind: "channel", memberHandles: [human, agentHandle] });
  channelId = chan.id;
  console.log("setup:", { humanId, agentId, maSessionId, channelId });

  ws = new WebSocket(`${WS}/?participantId=${humanId}`);

  const agentReplied = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout: no agent reply within 90s")), 90000);
    ws.on("message", (raw) => {
      const evt = JSON.parse(raw.toString());
      if (evt.type === "message" && evt.message.sender_id === agentId) {
        clearTimeout(timer);
        resolve(evt.message);
      }
    });
  });

  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({
    type: "post",
    channelId,
    body: `@${agentHandle} reply with a short friendly hello`,
    clientMsgId: "s4-1",
  }));

  const reply = await agentReplied;
  console.log("agent reply:", reply.sender_handle, "->", JSON.stringify(reply.body));

  const history = await fetch(`${BASE}/api/channels/${channelId}/messages`).then((r) => r.json());
  const persisted = history.find((m) => m.sender_id === agentId);

  const checks = {
    "agent reply received via WS": !!reply,
    "reply sender is the agent": reply.sender_handle === agentHandle,
    "reply body non-empty": !!reply.body && reply.body.trim().length > 0,
    "agent reply persisted in DB": !!persisted,
  };
  console.log("checks:", checks);
  pass = Object.values(checks).every(Boolean);
} catch (e) {
  console.error("ERROR:", e.message);
} finally {
  try { ws?.close(); } catch {}
  if (channelId) await pool.query("delete from channels where id = $1", [channelId]).catch(() => {});
  for (const id of [humanId, agentId]) if (id) await pool.query("delete from participants where id = $1", [id]).catch(() => {});
  await pool.end();
  if (maSessionId) await anthropic.beta.sessions.delete(maSessionId).catch(() => {});
}

console.log(pass ? "✅ STEP 4 PASS" : "❌ STEP 4 FAIL");
process.exit(pass ? 0 : 1);
