// Slack bridge end-to-end against a running test backend + fake Slack (slack-stub.mjs) + isolated
// test DB. Seeds a workspace/channel/install/link, then drives the signed events webhook and
// asserts DB state. Usage:
//   node test/slack-e2e.mjs <backendPort> <dbUrl> <signingSecret>
import { createHmac } from "node:crypto";
import pg from "pg";

const PORT = process.argv[2] ?? "3055";
const DBURL = process.argv[3];
const SECRET = process.argv[4] ?? "test_signing_secret_abc123";
const BASE = `http://localhost:${PORT}`;
if (!DBURL) throw new Error("usage: node slack-e2e.mjs <port> <dbUrl> <signingSecret>");

const db = new pg.Pool({ connectionString: DBURL });
const WS = "00000000-0000-0000-0000-000000000001";
const HUMAN = "11111111-1111-1111-1111-111111111111";
const AGENT = "22222222-2222-2222-2222-222222222222";
const CHAN = "33333333-3333-3333-3333-333333333333";
const TEAM = "T1";
const SLACK_CHAN = "C1";

let pass = 0;
const ok = (name) => (pass++, console.log(`  ✓ ${name}`));
const fail = (name, detail) => {
  console.error(`  ✗ ${name}\n    ${detail}`);
  process.exitCode = 1;
};
const assert = (cond, name, detail = "") => (cond ? ok(name) : fail(name, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seed() {
  await db.query(`insert into workspaces (id, name) values ($1,'Test WS') on conflict (id) do nothing`, [WS]);
  await db.query(
    `insert into participants (id, kind, workspace_id, handle, display_name, role)
     values ($1,'human',$2,'tester','Tester','admin') on conflict (id) do nothing`, [HUMAN, WS]);
  await db.query(
    `insert into participants (id, kind, workspace_id, handle, display_name, runner_token)
     values ($1,'agent',$2,'scout','Scout','rt-scout') on conflict (id) do nothing`, [AGENT, WS]);
  await db.query(
    `insert into channels (id, name, kind, workspace_id) values ($1,'general','channel',$2)
     on conflict (id) do nothing`, [CHAN, WS]);
  for (const p of [HUMAN, AGENT]) {
    await db.query(`insert into channel_members (channel_id, participant_id) values ($1,$2) on conflict do nothing`, [CHAN, p]);
  }
  await db.query(
    `insert into slack_installs (workspace_id, team_id, team_name, bot_token, bot_user_id, bot_id)
     values ($1,$2,'Test Team','xoxb-test','UBOT','BBOT')
     on conflict (workspace_id) do update set bot_token=excluded.bot_token`, [WS, TEAM]);
  await db.query(
    `insert into slack_channel_links (workspace_id, jungle_channel_id, slack_team_id, slack_channel_id, slack_channel_name)
     values ($1,$2,$3,$4,'general')
     on conflict (jungle_channel_id) do nothing`, [WS, CHAN, TEAM, SLACK_CHAN]);
}

function signedFetch(payload, { skew = 0, badSig = false } = {}) {
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000) + skew);
  const sig = badSig ? "v0=deadbeef" : "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${raw}`).digest("hex");
  return fetch(`${BASE}/api/slack/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": sig },
    body: raw,
  });
}

function messageEvent({ user = "U1", text = "hello", ts, thread_ts, event_id, subtype }) {
  return {
    type: "event_callback",
    team_id: TEAM,
    event_id: event_id ?? `Ev${Math.random().toString(36).slice(2)}`,
    event: { type: "message", subtype, user, channel: SLACK_CHAN, text, ts: ts ?? `${Date.now()}.000100`, thread_ts },
  };
}

async function run() {
  await seed();

  // A) url_verification handshake (signed) echoes the challenge.
  {
    const r = await signedFetch({ type: "url_verification", challenge: "chal-123" });
    const j = await r.json().catch(() => ({}));
    assert(r.status === 200 && j.challenge === "chal-123", "url_verification echoes challenge", `got ${r.status} ${JSON.stringify(j)}`);
  }

  // B) bad signature → 401.
  {
    const r = await signedFetch(messageEvent({ text: "nope" }), { badSig: true });
    assert(r.status === 401, "bad signature rejected (401)", `got ${r.status}`);
  }

  // C) a real message creates a shadow participant + persists, and is NOT mirrored back (origin slack).
  const tsC = `${Date.now()}.000200`;
  {
    const r = await signedFetch(messageEvent({ user: "U1", text: "hello @scout", ts: tsC }));
    assert(r.status === 200, "message event acked (200)", `got ${r.status}`);
    await sleep(800); // async processing after the ack
    const { rows: shadow } = await db.query(
      `select p.* from participants p join slack_user_links l on l.participant_id=p.id
       where l.slack_team_id=$1 and l.slack_user_id='U1'`, [TEAM]);
    assert(shadow.length === 1 && shadow[0].kind === "human" && shadow[0].firebase_uid === null,
      "shadow participant created for Slack user", JSON.stringify(shadow[0] ?? null));
    const { rows: msgs } = await db.query(
      `select m.* from messages m where m.channel_id=$1 and m.body='hello @scout'`, [CHAN]);
    assert(msgs.length === 1, "message persisted in linked channel", `count=${msgs.length}`);
    if (msgs[0]) {
      const { rows: out } = await db.query(`select * from slack_outbox where jungle_message_id=$1`, [msgs[0].id]);
      assert(out.length === 0, "ingested message NOT enqueued to outbox (echo-suppressed)", `outbox rows=${out.length}`);
      const { rows: ml } = await db.query(`select * from slack_message_links where jungle_message_id=$1`, [msgs[0].id]);
      assert(ml.length === 1 && ml[0].origin === "slack" && ml[0].slack_ts === tsC, "message_link recorded (origin slack)", JSON.stringify(ml[0] ?? null));
      const { rows: mentions } = await db.query(`select * from mentions where message_id=$1 and participant_id=$2`, [msgs[0].id, AGENT]);
      assert(mentions.length === 1, "@scout mention parsed (would trigger cascade)", `mentions=${mentions.length}`);
    }
  }

  // D) dedupe: same event_id twice → only one message.
  {
    const evId = "Ev-dupe-1";
    const ev = messageEvent({ user: "U1", text: "dupe-test", event_id: evId, ts: `${Date.now()}.000300` });
    await signedFetch(ev);
    await signedFetch(ev);
    await sleep(700);
    const { rows } = await db.query(`select count(*)::int n from messages where channel_id=$1 and body='dupe-test'`, [CHAN]);
    assert(rows[0].n === 1, "duplicate event_id deduped (one message)", `count=${rows[0].n}`);
  }

  // E) thread mapping: a reply whose thread_ts maps to msg C lands in C's thread.
  {
    const r = await signedFetch(messageEvent({ user: "U2", text: "in thread", thread_ts: tsC, ts: `${Date.now()}.000400` }));
    assert(r.status === 200, "thread reply acked", `got ${r.status}`);
    await sleep(800);
    const { rows: root } = await db.query(`select id from messages where channel_id=$1 and body='hello @scout'`, [CHAN]);
    const { rows: reply } = await db.query(`select * from messages where channel_id=$1 and body='in thread'`, [CHAN]);
    assert(reply.length === 1 && root.length === 1 && reply[0].thread_root_id === root[0].id,
      "thread reply attached to mapped root", `reply.thread_root_id=${reply[0]?.thread_root_id} root=${root[0]?.id}`);
  }

  // F) egress: a Jungle-origin message enqueued to the outbox is delivered to (stub) Slack and booked.
  {
    const { rows: ins } = await db.query(
      `insert into messages (channel_id, sender_id, body, cascade_budget) values ($1,$2,'from jungle',0) returning id`, [CHAN, HUMAN]);
    const mid = ins[0].id;
    const { rows: link } = await db.query(`select id from slack_channel_links where jungle_channel_id=$1`, [CHAN]);
    await db.query(`insert into slack_outbox (link_id, jungle_message_id) values ($1,$2)`, [link[0].id, mid]);
    // Wait for the ticker (SLACK_OUTBOX_TICK_MS=1000) to drain it.
    let delivered = false;
    for (let i = 0; i < 12; i++) {
      await sleep(600);
      const { rows } = await db.query(`select status from slack_outbox where jungle_message_id=$1`, [mid]);
      if (rows[0]?.status === "delivered") { delivered = true; break; }
    }
    assert(delivered, "outbox job delivered by ticker", "still pending after ~7s");
    const { rows: ml } = await db.query(`select * from slack_message_links where jungle_message_id=$1 and origin='jungle'`, [mid]);
    assert(ml.length === 1, "egress recorded a jungle-origin message_link", `rows=${ml.length}`);
  }

  console.log(`\n${pass} assertions passed`);
  await db.end();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
