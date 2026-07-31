// Regression test for the "#dm" destination collision bug. Every DM channel is created with the
// literal name "dm" (findOrCreateDm), and every DM turn's routing instructions tell the agent to
// reply with send_message to:"#dm" (buildAgentTurnInput's DM branch). Resolving that by NAME
// across every DM the agent belongs to is ambiguous — getChannelByNameForMember nondeterministically
// picked whichever DM channel was oldest, so a reply meant for one person could land in a
// different teammate's DM (the one that happened to be created first).
//
// Two humans DM the same test agent — Alice's DM created first (older), Bob's second (newer) — and
// we drive the agent's runner socket ourselves (no real Anthropic session) so its reply always
// targets the ambiguous "#dm" destination, exactly like a real turn would. Bob's reply must land
// in Bob's DM, not fall back into Alice's older one — and Alice's own DM must be unaffected.
//
// Run (backend up, dev-bypass auth): set -a; . .env; set +a; node backend/test/dm-reply-routing.mjs
import { WebSocket } from "ws";
import pg from "pg";

const BASE = "http://localhost:3001";
const WSBASE = "ws://localhost:3001";
const sfx = Date.now().toString(36);
const aliceHandle = `alice_${sfx}`;
const bobHandle = `bob_${sfx}`;
const agentHandle = `dmtest_${sfx}`;
const runnerToken = `rt_dmtest_${sfx}`;

const post = (p, b, qs = "") =>
  fetch(BASE + p + qs, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let pass = false;
const cleanup = { participants: [], channels: [] };
let runnerWs = null;
let bobWs = null;
let aliceWs = null;

try {
  const alice = await post("/api/participants", { kind: "human", handle: aliceHandle, displayName: "Alice" });
  cleanup.participants.push(alice.id);
  const bob = await post("/api/participants", { kind: "human", handle: bobHandle, displayName: "Bob" });
  cleanup.participants.push(bob.id);

  // Seed the test agent directly — skip the real /api/agents path (no real Anthropic session or
  // runner container); we drive its runner socket ourselves below.
  const { rows: agentRows } = await pool.query(
    `insert into participants (kind, workspace_id, handle, display_name, runner_token)
     values ('agent', $1, $2, 'DM Test Agent', $3) returning id`,
    [alice.workspace_id, agentHandle, runnerToken],
  );
  const agentId = agentRows[0].id;
  cleanup.participants.push(agentId);

  // Alice's DM with the agent first (older), then Bob's (newer) — mirrors the real-world shape of
  // the bug (whoever DM'd the agent first "absorbed" everyone else's replies).
  const dmAlice = (await post("/api/dms", { otherId: agentId }, `?participantId=${alice.id}`)).id;
  cleanup.channels.push(dmAlice);
  const dmBob = (await post("/api/dms", { otherId: agentId }, `?participantId=${bob.id}`)).id;
  cleanup.channels.push(dmBob);

  // Drive the agent's runner socket ourselves: ack hello/configure, and on every enqueue reply
  // with send_message to:"#dm" — exactly the ambiguous destination the real orchestrator prompt
  // sends for every DM turn.
  runnerWs = new WebSocket(`${WSBASE}/api/runner?token=${runnerToken}`);
  await new Promise((resolve, reject) => {
    runnerWs.on("open", resolve);
    runnerWs.on("error", reject);
  });
  runnerWs.send(JSON.stringify({ type: "hello", agentId, sessionId: `dmtest-sess-${sfx}`, protocol: 1 }));
  let turnCounter = 0;
  runnerWs.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "configure") {
      runnerWs.send(JSON.stringify({
        type: "state", state: "idle", sessionId: `dmtest-sess-${sfx}`,
        model: frame.model, permissionMode: frame.permissionMode,
      }));
    }
    if (frame.type === "enqueue") {
      const inboxIds = (frame.items || []).map((i) => i.inboxId);
      const turnId = `turn-${++turnCounter}`;
      runnerWs.send(JSON.stringify({ type: "turn_started", turnId, inboxIds }));
      runnerWs.send(JSON.stringify({ type: "consumed", inboxIds, turnId }));
      runnerWs.send(JSON.stringify({ type: "send_message", id: `sm-${turnId}`, input: { to: "#dm", body: "auto-reply" } }));
      setTimeout(() => runnerWs.send(JSON.stringify({ type: "turn_done", turnId, ok: true })), 300);
    }
  });
  await new Promise((r) => setTimeout(r, 1000)); // let hello/configure settle

  const countAgentMsgs = async (channelId) =>
    (await pool.query(`select count(*)::int n from messages where channel_id=$1 and sender_id=$2`, [channelId, agentId])).rows[0].n;

  // Bob DMs the agent (the NEWER DM channel) — his reply must land in HIS dm, not Alice's older one.
  bobWs = new WebSocket(`${WSBASE}/?participantId=${bob.id}`);
  await new Promise((r) => bobWs.on("open", r));
  bobWs.send(JSON.stringify({ type: "post", channelId: dmBob, clientMsgId: "b1", body: "hi from bob" }));
  for (let i = 0; i < 20 && (await countAgentMsgs(dmBob)) === 0; i++) await new Promise((r) => setTimeout(r, 500));

  const bobDmCount = await countAgentMsgs(dmBob);
  const aliceDmCountAfterBob = await countAgentMsgs(dmAlice);

  // Alice DMs the agent too — her reply must land in HER dm and must not disturb Bob's.
  aliceWs = new WebSocket(`${WSBASE}/?participantId=${alice.id}`);
  await new Promise((r) => aliceWs.on("open", r));
  aliceWs.send(JSON.stringify({ type: "post", channelId: dmAlice, clientMsgId: "a1", body: "hi from alice" }));
  for (let i = 0; i < 20 && (await countAgentMsgs(dmAlice)) === 0; i++) await new Promise((r) => setTimeout(r, 500));

  const aliceDmCountFinal = await countAgentMsgs(dmAlice);
  const bobDmCountFinal = await countAgentMsgs(dmBob);

  console.log("counts:", { bobDmCount, aliceDmCountAfterBob, aliceDmCountFinal, bobDmCountFinal });
  const checks = {
    "Bob's reply landed in Bob's DM": bobDmCount === 1,
    "Bob's reply did NOT leak into Alice's (older) DM": aliceDmCountAfterBob === 0,
    "Alice's reply landed in Alice's DM": aliceDmCountFinal === 1,
    "Alice's DM reply did NOT disturb Bob's DM": bobDmCountFinal === 1,
  };
  console.log("checks:", checks);
  pass = Object.values(checks).every(Boolean);
} catch (e) {
  console.error("ERROR:", e);
} finally {
  runnerWs?.close();
  bobWs?.close();
  aliceWs?.close();
  for (const id of cleanup.channels) await pool.query("delete from channels where id = $1", [id]).catch(() => {});
  for (const id of cleanup.participants) await pool.query("delete from participants where id = $1", [id]).catch(() => {});
  await pool.end();
}

console.log(pass ? "✅ DM-REPLY-ROUTING PASS" : "❌ DM-REPLY-ROUTING FAIL");
process.exit(pass ? 0 : 1);
