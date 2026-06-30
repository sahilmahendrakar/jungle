// Regression test for the "@hyphenated-handle didn't respond" bug + auto-add on mention.
// Agent handle CONTAINS a hyphen and is NOT a member of the channel. @mentioning it must:
//   (1) parse the full hyphenated handle, (2) auto-add the agent to the channel,
//   (3) the agent replies in that channel. Self-cleaning. Exit 0 = PASS.
// Run (backend up): set -a; . .env; set +a; node backend/test/mention-fix.mjs
import { WebSocket } from "ws";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";

const BASE = "http://localhost:3001";
const WS = "ws://localhost:3001";
const sfx = Date.now().toString(36);
const human = `human_${sfx}`;
const ag = `helper-${sfx}`; // <- hyphen on purpose
const chan = `room_${sfx}`;
const post = (p, b) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic();
let pass = false;
const cleanup = { participants: [], channels: [], sessions: [] };

try {
  const H = await post("/api/participants", { kind: "human", handle: human, displayName: "Human" });
  cleanup.participants.push(H.id);
  const A = await post("/api/agents", { handle: ag, displayName: "Helper" });
  cleanup.participants.push(A.id);
  if (A.ma_session_id) cleanup.sessions.push(A.ma_session_id);
  // Channel with ONLY the human — the agent is intentionally NOT a member.
  const c = await post("/api/channels", { name: chan, kind: "channel", memberHandles: [human] });
  cleanup.channels.push(c.id);
  console.log("setup:", { human, ag, channel: c.id, agentIsMemberInitially: false });

  const ws = new WebSocket(`${WS}/?participantId=${H.id}`);
  await new Promise((r) => ws.on("open", r));
  const replies = [];
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === "message" && m.message?.sender_id === A.id) replies.push(m.message.body);
    } catch {}
  });

  ws.send(JSON.stringify({ type: "post", channelId: c.id, clientMsgId: "m1", body: `@${ag} hi` }));

  for (let i = 0; i < 45 && replies.length === 0; i++) await new Promise((r) => setTimeout(r, 1500));
  ws.close();

  const memberNow = (await pool.query(
    "select 1 from channel_members where channel_id=$1 and participant_id=$2", [c.id, A.id],
  )).rows.length > 0;

  console.log("agent replies:", replies.length, replies[0]?.slice(0, 80) ?? "");
  const checks = {
    "hyphenated @mention triggered the agent": replies.length > 0,
    "agent auto-added to the channel": memberNow,
  };
  console.log("checks:", checks);
  pass = Object.values(checks).every(Boolean);
} catch (e) {
  console.error("ERROR:", e.message);
} finally {
  for (const id of cleanup.channels) await pool.query("delete from channels where id = $1", [id]).catch(() => {});
  for (const id of cleanup.participants) await pool.query("delete from participants where id = $1", [id]).catch(() => {});
  await pool.end();
  for (const s of cleanup.sessions) await anthropic.beta.sessions.delete(s).catch(() => {});
}

console.log(pass ? "✅ MENTION-FIX PASS" : "❌ MENTION-FIX FAIL");
process.exit(pass ? 0 : 1);
