// Step 6 verification: agent -> agent cascade + budget guardrail.
// Human mentions only Alpha and asks Alpha to mention Bravo. Bravo posting proves an
// agent's reply re-entered the routing rule. Budgets must decrement 3 (human) -> 2
// (Alpha) -> 1 (Bravo), and the cascade must not run away. Exit 0 = PASS. Self-cleaning.
//
// Run: set -a; . ~/.config/jungle/.env; set +a; node backend/test/step6.mjs
import { WebSocket } from "ws";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";

const BASE = "http://localhost:3001";
const WS = "ws://localhost:3001";
const sfx = Date.now().toString(36);
const human = `h_${sfx}`;
const aaa = `alpha_${sfx}`;
const bbb = `bravo_${sfx}`;
const chanName = `step6_${sfx}`;
const post = (p, b) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic();
let pass = false;
let channelId, humanId, aId, bId, aSession, bSession, ws;

try {
  humanId = (await post("/api/participants", { kind: "human", handle: human, displayName: "Human" })).id;
  const A = await post("/api/agents", { handle: aaa, displayName: "Alpha" });
  aId = A.id; aSession = A.ma_session_id;
  const B = await post("/api/agents", { handle: bbb, displayName: "Bravo" });
  bId = B.id; bSession = B.ma_session_id;
  channelId = (await post("/api/channels", { name: chanName, kind: "channel", memberHandles: [human, aaa, bbb] })).id;
  console.log("setup:", { humanId, aId, bId, channelId });

  ws = new WebSocket(`${WS}/?participantId=${humanId}`);
  const bravoPosted = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout: Bravo never posted (agent->agent cascade did not fire)")), 150000);
    ws.on("message", (raw) => {
      const evt = JSON.parse(raw.toString());
      if (evt.type === "message" && evt.message.sender_id === bId) {
        clearTimeout(timer);
        resolve(evt.message);
      }
    });
  });

  await new Promise((r) => ws.on("open", r));
  // Body mentions ONLY @alpha. Bravo's handle appears as plain text (no @), so Bravo
  // is NOT mentioned by the human — only Alpha can trigger Bravo.
  ws.send(JSON.stringify({
    type: "post",
    channelId,
    body: `@${aaa} Hi! Please do two things in your reply: (1) say hello to me, and (2) notify your teammate whose handle is "${bbb}" by mentioning them — write the @ symbol directly followed by ${bbb} (no space), and ask them to say hello back.`,
    clientMsgId: "s6-1",
  }));

  const bravoMsg = await bravoPosted;
  console.log("bravo posted:", JSON.stringify(bravoMsg.body));

  await new Promise((r) => setTimeout(r, 3000)); // let any further cascade settle
  const { rows } = await pool.query(
    `select p.handle, p.kind, m.cascade_budget as budget, m.seq from messages m
     join participants p on p.id = m.sender_id where m.channel_id = $1 order by m.seq`,
    [channelId],
  );
  console.log("messages:", rows);

  const humanMsg = rows.find((r) => r.kind === "human");
  const alphaMsg = rows.find((r) => r.handle === aaa);
  const bravoRow = rows.find((r) => r.handle === bbb);
  const agentMsgCount = rows.filter((r) => r.kind === "agent").length;

  const checks = {
    "agent->agent cascade fired (Bravo posted)": !!bravoRow,
    "human msg budget = 3": humanMsg?.budget === 3,
    "Alpha reply budget = 2": alphaMsg?.budget === 2,
    "Bravo reply budget = 1": bravoRow?.budget === 1,
    "no runaway (agent msgs <= 5)": agentMsgCount <= 5,
  };
  console.log("checks:", checks);
  pass = Object.values(checks).every(Boolean);
} catch (e) {
  console.error("ERROR:", e.message);
} finally {
  try { ws?.close(); } catch {}
  if (channelId) await pool.query("delete from channels where id = $1", [channelId]).catch(() => {});
  for (const id of [humanId, aId, bId]) if (id) await pool.query("delete from participants where id = $1", [id]).catch(() => {});
  await pool.end();
  for (const s of [aSession, bSession]) if (s) await anthropic.beta.sessions.delete(s).catch(() => {});
}

console.log(pass ? "✅ STEP 6 PASS" : "❌ STEP 6 FAIL");
process.exit(pass ? 0 : 1);
