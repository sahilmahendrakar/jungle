// Message deletion (migrations/048) end to end: the permission rule, the live message_deleted
// fan-out, what a delete cleans up, and — the part a naive `delete from messages` gets wrong —
// what happens around THREADS and UNREAD state.
//
// Usage: TEST_DATABASE_URL=… node backend/test/message-delete.mjs <backendPort>
// Assumes a dev-bypass backend (AUTH_DEV_BYPASS=1) on that port against that same database.
// The test seeds its own workspace, humans, agent and channel, so it needs no fixtures.
import WebSocket from "ws";
import pg from "pg";

const PORT = process.argv[2] ?? "3061";
const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) throw new Error("usage: TEST_DATABASE_URL=… node message-delete.mjs <port>");
const API = `http://localhost:${PORT}/api`;
const pool = new pg.Pool({ connectionString: TEST_DB });
const tag = Date.now().toString(36).slice(-5);

const raw = async (method, path, body, as) => {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${API}${path}${as ? `${sep}participantId=${as}` : ""}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const api = async (method, path, body, as) => {
  const r = await raw(method, path, body, as);
  if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};

let pass = 0, fail = 0;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

function collector(ws) {
  const seen = [], waiters = [];
  ws.on("message", (b) => {
    const f = JSON.parse(b.toString());
    seen.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(f)) waiters.splice(i, 1)[0].resolve(f);
    }
  });
  return {
    seen,
    waitFor(name, match, timeoutMs = 10_000) {
      const hit = seen.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
        waiters.push({ match, resolve: (f) => { clearTimeout(t); resolve(f); } });
      });
    },
  };
}

// Post over the app WS (the only way a human posts) and wait for the message frame back.
async function post(ws, coll, channelId, body, extra = {}) {
  const clientMsgId = `t-${Math.random().toString(36).slice(2)}`;
  ws.send(JSON.stringify({ type: "post", channelId, body, clientMsgId, ...extra }));
  const f = await coll.waitFor(
    `message ${body.slice(0, 20)}`,
    (x) => x.type === "message" && x.message?.body === body,
  );
  return f.message;
}

const history = (channelId, as) => api("GET", `/channels/${channelId}/messages`, null, as);

async function seed() {
  const ws = (await pool.query(
    `insert into workspaces (name) values ($1) returning id`,
    [`del-${tag}`],
  )).rows[0].id;
  const human = async (handle, role = "member") =>
    (await pool.query(
      `insert into participants (kind, handle, display_name, workspace_id, role)
       values ('human', $1, $2, $3, $4) returning id`,
      [`${handle}-${tag}`, handle, ws, role],
    )).rows[0].id;
  const alice = await human("Alice", "admin");
  const bob = await human("Bob");
  const carol = await human("Carol"); // in the workspace, NOT in the channel
  const agent = (await pool.query(
    `insert into participants
       (kind, handle, display_name, mode, effort, runtime, runner_provider, workspace_id, role)
     values ('agent',$1,'Robot','bypassPermissions','medium','sdk','docker',$2,'member')
     returning id`,
    [`robot-${tag}`, ws],
  )).rows[0].id;
  const channel = (await pool.query(
    `insert into channels (name, kind, workspace_id) values ($1,'channel',$2) returning id`,
    [`del-${tag}`, ws],
  )).rows[0].id;
  for (const p of [alice, bob, agent]) {
    await pool.query(
      `insert into channel_members (channel_id, participant_id) values ($1,$2)`,
      [channel, p],
    );
  }
  return { ws, alice, bob, carol, agent, channel };
}

// An agent's message, inserted the way the runner's send_message path would (no container here).
async function agentSays(channel, agent, body) {
  return (await pool.query(
    `insert into messages (channel_id, sender_id, body) values ($1,$2,$3) returning id, seq`,
    [channel, agent, body],
  )).rows[0];
}

async function main() {
  const { alice, bob, carol, agent, channel } = await seed();

  const aliceWs = new WebSocket(`ws://localhost:${PORT}?participantId=${alice}`);
  const aliceC = collector(aliceWs);
  await new Promise((r) => aliceWs.on("open", r));
  const bobWs = new WebSocket(`ws://localhost:${PORT}?participantId=${bob}`);
  const bobC = collector(bobWs);
  await new Promise((r) => bobWs.on("open", r));

  // ---- 1. a human deletes their own message ----
  const m1 = await post(aliceWs, aliceC, channel, "delete me please");
  const del = await raw("DELETE", `/messages/${m1.id}`, null, alice);
  check("sender can delete their own message", del.status === 200, JSON.stringify(del.body));
  const frame = await bobC.waitFor(
    "message_deleted",
    (f) => f.type === "message_deleted" && f.messageId === m1.id,
  );
  check("delete fans out to other members live", frame.channelId === channel);
  check("a plain message is NOT a tombstone", frame.tombstone === false);
  check(
    "deleted message is gone from history",
    !(await history(channel, alice)).some((m) => m.id === m1.id),
  );
  const row = (await pool.query(`select body, deleted_at, deleted_by from messages where id=$1`, [m1.id])).rows[0];
  check("row survives with the body destroyed", !!row.deleted_at && row.body === "");
  check("deleter is recorded", row.deleted_by === alice);

  // ---- 2. the permission rule ----
  const m2 = await post(aliceWs, aliceC, channel, "alice's other message");
  const byBob = await raw("DELETE", `/messages/${m2.id}`, null, bob);
  check("a human cannot delete another human's message", byBob.status === 403, `status=${byBob.status}`);
  const byCarol = await raw("DELETE", `/messages/${m2.id}`, null, carol);
  check("a non-member cannot delete anything in the channel", byCarol.status === 403, `status=${byCarol.status}`);

  const a1 = await agentSays(channel, agent, "agent output nobody wants");
  const agentDel = await raw("DELETE", `/messages/${a1.id}`, null, bob);
  check(
    "ANY human member can delete an agent's message",
    agentDel.status === 200,
    JSON.stringify(agentDel.body),
  );
  check("404 for a message that doesn't exist",
    (await raw("DELETE", `/messages/00000000-0000-0000-0000-000000000000`, null, alice)).status === 404);
  check("deleting twice is idempotent",
    (await raw("DELETE", `/messages/${a1.id}`, null, bob)).status === 200);

  // ---- 3. threads: the denormed reply_count must come back DOWN ----
  const root = await post(aliceWs, aliceC, channel, "thread root");
  const r1 = await post(aliceWs, aliceC, channel, "first reply", { threadRootId: root.id });
  await post(aliceWs, aliceC, channel, "second reply", { threadRootId: root.id });
  const before = (await history(channel, alice)).find((m) => m.id === root.id);
  check("root counts both replies", before.reply_count === 2, `count=${before.reply_count}`);
  await api("DELETE", `/messages/${r1.id}`, null, alice);
  const afterReplyDelete = (await history(channel, alice)).find((m) => m.id === root.id);
  check(
    "deleting a reply decrements the root's reply_count",
    afterReplyDelete.reply_count === 1,
    `count=${afterReplyDelete.reply_count}`,
  );

  // Deleting the ROOT must not take the surviving replies with it (thread_root_id is ON DELETE
  // CASCADE — this is exactly what a hard delete would get wrong).
  const rootDel = await raw("DELETE", `/messages/${root.id}`, null, alice);
  check("root can be deleted", rootDel.status === 200);
  const tombFrame = await aliceC.waitFor(
    "root message_deleted",
    (f) => f.type === "message_deleted" && f.messageId === root.id,
  );
  check("a root with live replies is announced as a tombstone", tombFrame.tombstone === true);
  const afterRootDelete = await history(channel, alice);
  const tomb = afterRootDelete.find((m) => m.id === root.id);
  check("the root is still served, as a tombstone", !!tomb && !!tomb.deleted_at && tomb.body === "");
  check(
    "the other replies survive the root's deletion",
    afterRootDelete.some((m) => m.body === "second reply"),
  );
  const survivors = (await pool.query(
    `select count(*)::int as n from messages where thread_root_id = $1 and deleted_at is null`,
    [root.id],
  )).rows[0].n;
  check("no cascade wiped the replies from the table", survivors === 1, `live replies=${survivors}`);

  // ---- 4. unread state must not count a deleted message ----
  const before2 = (await api("GET", "/channels", null, bob)).find((c) => c.id === channel);
  const ghost = await post(aliceWs, aliceC, channel, `@Bob-${tag} ping`);
  const withGhost = (await api("GET", "/channels", null, bob)).find((c) => c.id === channel);
  check("an unread message raises Bob's badge",
    withGhost.unread_count === before2.unread_count + 1,
    `${before2.unread_count} -> ${withGhost.unread_count}`);
  check("...and flags a mention", withGhost.has_mention === true);
  await api("DELETE", `/messages/${ghost.id}`, null, alice);
  const afterGhost = (await api("GET", "/channels", null, bob)).find((c) => c.id === channel);
  check(
    "deleting it takes the unread back down (no badge pointing at nothing)",
    afterGhost.unread_count === before2.unread_count,
    `${withGhost.unread_count} -> ${afterGhost.unread_count}`,
  );
  const mentionRows = (await pool.query(
    `select count(*)::int as n from mentions where message_id = $1`, [ghost.id],
  )).rows[0].n;
  check("its mention rows are gone too", mentionRows === 0);

  // ---- 5. search must not surface deleted bodies ----
  const secret = `zebrafish${tag}`;
  const m3 = await post(aliceWs, aliceC, channel, `the word is ${secret}`);
  const found = await api("GET", `/search?q=${secret}`, null, alice);
  check("search finds the message while it lives", found.results?.length === 1, JSON.stringify(found.results?.length));
  await api("DELETE", `/messages/${m3.id}`, null, alice);
  const gone = await api("GET", `/search?q=${secret}`, null, alice);
  check("search no longer finds it once deleted", (gone.results ?? []).length === 0);

  // ---- 6. an undelivered agent dispatch is cancelled ----
  const m4 = await post(aliceWs, aliceC, channel, "work I changed my mind about");
  await pool.query(
    `insert into agent_inbox (agent_id, text, context) values ($1, $2, $3)`,
    [agent, "queued work", JSON.stringify({ channelId: channel, messageId: m4.id })],
  );
  await api("DELETE", `/messages/${m4.id}`, null, alice);
  const pending = (await pool.query(
    `select count(*)::int as n from agent_inbox
      where delivered_at is null and context->>'messageId' = $1`, [m4.id],
  )).rows[0].n;
  check("deleting a message drops the agent work it had queued", pending === 0);

  aliceWs.close();
  bobWs.close();
  await pool.end();
  log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
