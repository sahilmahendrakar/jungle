// Step 3 verification: human<->human messaging over WebSocket.
// Two clients in one channel; A posts; assert B receives it live AND it persisted
// in Postgres with a seq. Self-cleaning (deletes its test rows). Exit 0 = PASS.
//
// Run:  set -a; . .env; set +a; node backend/test/step3.mjs
import { WebSocket } from "ws";
import pg from "pg";

const BASE = "http://localhost:3001";
const WS = "ws://localhost:3001";
const sfx = Date.now().toString(36);
const aliceHandle = `alice_${sfx}`;
const bobHandle = `bob_${sfx}`;
const chanName = `step3_${sfx}`;
const BODY = `hello @${bobHandle}`;

const post = (path, body) =>
  fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let pass = false;
let channelId, aliceId, bobId, aliceWs, bobWs;

try {
  const alice = await post("/api/participants", { kind: "human", handle: aliceHandle, displayName: "Alice" });
  const bob = await post("/api/participants", { kind: "human", handle: bobHandle, displayName: "Bob" });
  aliceId = alice.id;
  bobId = bob.id;
  const chan = await post("/api/channels", { name: chanName, kind: "channel", memberHandles: [aliceHandle, bobHandle] });
  channelId = chan.id;
  console.log("setup:", { aliceId, bobId, channelId });

  aliceWs = new WebSocket(`${WS}/?participantId=${aliceId}`);
  bobWs = new WebSocket(`${WS}/?participantId=${bobId}`);

  const bobReceived = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout: bob never received the message")), 5000);
    bobWs.on("message", (raw) => {
      const evt = JSON.parse(raw.toString());
      if (evt.type === "message" && evt.message.body === BODY) {
        clearTimeout(timer);
        resolve(evt.message);
      }
    });
  });

  await Promise.all([
    new Promise((r) => aliceWs.on("open", r)),
    new Promise((r) => bobWs.on("open", r)),
  ]);

  aliceWs.send(JSON.stringify({ type: "post", channelId, body: BODY, clientMsgId: "t1" }));

  const received = await bobReceived;
  console.log("bob received:", received);

  const history = await fetch(`${BASE}/api/channels/${channelId}/messages`).then((r) => r.json());
  const persisted = history.find((m) => m.body === BODY);

  const checks = {
    "bob received via WS": !!received,
    "sender is alice": received.sender_handle === aliceHandle,
    "has monotonic seq": Number(received.seq) > 0,
    "mention resolved to bob": received.mentions?.some((m) => m.handle === bobHandle),
    "persisted in DB (REST history)": !!persisted,
    "persisted seq matches WS seq": persisted && String(persisted.seq) === String(received.seq),
  };
  console.log("checks:", checks);
  pass = Object.values(checks).every(Boolean);
} catch (e) {
  console.error("ERROR:", e.message);
} finally {
  try { aliceWs?.close(); bobWs?.close(); } catch {}
  if (channelId) await pool.query("delete from channels where id = $1", [channelId]).catch(() => {});
  for (const id of [aliceId, bobId]) if (id) await pool.query("delete from participants where id = $1", [id]).catch(() => {});
  await pool.end();
}

console.log(pass ? "✅ STEP 3 PASS" : "❌ STEP 3 FAIL");
process.exit(pass ? 0 : 1);
