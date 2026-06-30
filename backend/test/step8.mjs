// Step 8 verification: cross-device guarantees.
//  (1) Multi-device fan-out: two sockets for the same participant both receive a message.
//  (2) Async delivery: a human @mentions an agent then DISCONNECTS before the reply; the
//      agent's reply still persists and is retrievable from history (laptop -> phone later).
// Exit 0 = PASS. Self-cleaning.
//
// Run: set -a; . .env; set +a; node backend/test/step8.mjs
import { WebSocket } from "ws";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";

const BASE = "http://localhost:3001";
const WS = "ws://localhost:3001";
const sfx = Date.now().toString(36);
const post = (p, b) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const openWs = (pid) => {
  const ws = new WebSocket(`${WS}/?participantId=${pid}`);
  return new Promise((res) => ws.on("open", () => res(ws)));
};
const onMessage = (ws, pred, ms, label) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    ws.on("message", (raw) => {
      const evt = JSON.parse(raw.toString());
      if (evt.type === "message" && pred(evt.message)) { clearTimeout(t); resolve(evt.message); }
    });
  });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic();
let pass = false;
const ids = { participants: [], channels: [], sessions: [] };

try {
  // --- Part 1: multi-device fan-out ---
  const h = await post("/api/participants", { kind: "human", handle: `h_${sfx}`, displayName: "H" });
  const o = await post("/api/participants", { kind: "human", handle: `o_${sfx}`, displayName: "O" });
  ids.participants.push(h.id, o.id);
  const c1 = await post("/api/channels", { name: `mdev_${sfx}`, kind: "channel", memberHandles: [`h_${sfx}`, `o_${sfx}`] });
  ids.channels.push(c1.id);

  const dev1 = await openWs(h.id);
  const dev2 = await openWs(h.id); // same participant, second device
  const o1 = await openWs(o.id);
  const body1 = `multi-device hello ${sfx}`;
  const got1 = onMessage(dev1, (m) => m.body === body1, 8000, "device1 receive");
  const got2 = onMessage(dev2, (m) => m.body === body1, 8000, "device2 receive");
  o1.send(JSON.stringify({ type: "post", channelId: c1.id, body: body1, clientMsgId: "md1" }));
  await Promise.all([got1, got2]);
  const multiDeviceOk = true;
  dev1.close(); dev2.close(); o1.close();

  // --- Part 2: async delivery (disconnect before the agent replies) ---
  const agent = await post("/api/agents", { handle: `async_${sfx}`, displayName: "Async Bot" });
  ids.participants.push(agent.id); ids.sessions.push(agent.ma_session_id);
  const c2 = await post("/api/channels", { name: `async_${sfx}`, kind: "channel", memberHandles: [`h_${sfx}`, `async_${sfx}`] });
  ids.channels.push(c2.id);

  const tmp = await openWs(h.id);
  tmp.send(JSON.stringify({ type: "post", channelId: c2.id, body: `@async_${sfx} say hi`, clientMsgId: "as1" }));
  tmp.close(); // DISCONNECT immediately — before the agent's turn finishes

  // Poll history (as a returning device would) until the agent's reply shows up.
  let agentReply = null;
  for (let i = 0; i < 60 && !agentReply; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const hist = await fetch(`${BASE}/api/channels/${c2.id}/messages`).then((r) => r.json());
    agentReply = hist.find((m) => m.sender_id === agent.id);
  }
  console.log("async agent reply:", agentReply && JSON.stringify(agentReply.body));

  const checks = {
    "multi-device: both sockets received": multiDeviceOk,
    "async: agent reply persisted despite disconnect": !!agentReply,
    "async: reply retrievable from history": !!agentReply && agentReply.body.trim().length > 0,
  };
  console.log("checks:", checks);
  pass = Object.values(checks).every(Boolean);
} catch (e) {
  console.error("ERROR:", e.message);
} finally {
  for (const id of ids.channels) await pool.query("delete from channels where id = $1", [id]).catch(() => {});
  for (const id of ids.participants) await pool.query("delete from participants where id = $1", [id]).catch(() => {});
  await pool.end();
  for (const s of ids.sessions) await anthropic.beta.sessions.delete(s).catch(() => {});
}

console.log(pass ? "✅ STEP 8 PASS" : "❌ STEP 8 FAIL");
process.exit(pass ? 0 : 1);
