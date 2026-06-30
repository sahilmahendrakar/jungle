// Verify tool-only sending: an agent communicates exclusively via send_message, and can
// (1) reply in the triggering channel, (2) post in a DIFFERENT channel it belongs to, and
// (3) DM a participant (auto-creating the DM channel) — all in one turn. Exit 0 = PASS.
// Self-cleaning. Requires the agent config to have the send_message tool (scripts/update-agent.mjs).
//
// Run: set -a; . .env; set +a; node backend/test/send-tool.mjs
import { WebSocket } from "ws";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";

const BASE = "http://localhost:3001";
const WS = "ws://localhost:3001";
const sfx = Date.now().toString(36);
const human = `u_${sfx}`;
const ag = `tooly_${sfx}`;
const c1n = `one_${sfx}`;
const c2n = `two_${sfx}`;
const post = (p, b) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic();
let pass = false;
const cleanup = { participants: [], channels: [], sessions: [] };

try {
  const H = await post("/api/participants", { kind: "human", handle: human, displayName: "User" });
  cleanup.participants.push(H.id);
  const A = await post("/api/agents", { handle: ag, displayName: "Tooly" });
  cleanup.participants.push(A.id); cleanup.sessions.push(A.ma_session_id);
  const c1 = await post("/api/channels", { name: c1n, kind: "channel", memberHandles: [human, ag] });
  const c2 = await post("/api/channels", { name: c2n, kind: "channel", memberHandles: [human, ag] });
  cleanup.channels.push(c1.id, c2.id);
  console.log("setup:", { H: H.id, A: A.id, c1: c1.id, c2: c2.id });

  const ws = new WebSocket(`${WS}/?participantId=${H.id}`);
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({
    type: "post",
    channelId: c1.id,
    clientMsgId: "st1",
    body: `@${ag} Please do all three of these, each with its own send_message call: ` +
      `(1) reply here in #${c1n} with a hello, ` +
      `(2) post in #${c2n} with the text "cross channel", and ` +
      `(3) direct-message me with to:"@${human}" and the text "dm hello".`,
  }));

  let c1msg, c2msg, dmmsg;
  for (let i = 0; i < 60 && !(c1msg && c2msg && dmmsg); i++) {
    await new Promise((r) => setTimeout(r, 1500));
    c1msg = (await pool.query("select 1 from messages where channel_id=$1 and sender_id=$2 limit 1", [c1.id, A.id])).rows[0];
    c2msg = (await pool.query("select 1 from messages where channel_id=$1 and sender_id=$2 limit 1", [c2.id, A.id])).rows[0];
    dmmsg = (await pool.query(
      `select m.id from messages m
       join channels c on c.id = m.channel_id and c.kind = 'dm'
       where m.sender_id = $1
         and exists (select 1 from channel_members cm where cm.channel_id = c.id and cm.participant_id = $2)
         and (select count(*) from channel_members cm2 where cm2.channel_id = c.id) = 2
       limit 1`, [A.id, H.id])).rows[0];
  }
  console.log("results:", { c1msg: !!c1msg, c2msg: !!c2msg, dmmsg: !!dmmsg });
  ws.close();

  const checks = {
    "agent replied in triggering channel (via tool)": !!c1msg,
    "agent posted in a DIFFERENT channel": !!c2msg,
    "agent DM'd a participant (DM channel auto-created)": !!dmmsg,
  };
  console.log("checks:", checks);
  pass = Object.values(checks).every(Boolean);
} catch (e) {
  console.error("ERROR:", e.message);
} finally {
  for (const id of cleanup.channels) await pool.query("delete from channels where id = $1", [id]).catch(() => {});
  // delete any auto-created DM channels involving the test agent/human
  await pool.query(
    `delete from channels where kind = 'dm' and id in (select channel_id from channel_members where participant_id = any($1))`,
    [cleanup.participants],
  ).catch(() => {});
  for (const id of cleanup.participants) await pool.query("delete from participants where id = $1", [id]).catch(() => {});
  await pool.end();
  for (const s of cleanup.sessions) await anthropic.beta.sessions.delete(s).catch(() => {});
}

console.log(pass ? "✅ SEND-TOOL PASS" : "❌ SEND-TOOL FAIL");
process.exit(pass ? 0 : 1);
