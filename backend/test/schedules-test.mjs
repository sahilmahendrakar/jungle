// schedules-test.mjs — end-to-end test of the schedules feature against an ISOLATED test DB.
//
// Boots the backend (dev-bypass, fast ticker) against $TEST_DATABASE_URL with Fly neutralized,
// connects a fake runner, and asserts:
//   1. one-shot fire: the fake runner receives an `enqueue` carrying the prompt, and the row's
//      next_run_at is null BEFORE the dispatch (advance-before-dispatch), with the inbox item's
//      context carrying the scheduleId + the turn_id stamped (context-fix + attribution).
//   2. validation: dense cron / bad tz / past runAt / over-long prompt all 400.
//   3. auto-pause: three consecutive failed turns flip failure_count=3 + paused_at (with a
//      pause notice fanned out).
//
// Requires postgres superuser to have already created the DB + applied schema (see the harness
// commands in the PR). Run:
//   set -a; . ../../.env; set +a
//   TEST_DATABASE_URL="${DATABASE_URL%/*}/jungle_sched_test" node backend/test/schedules-test.mjs

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  console.error("set TEST_DATABASE_URL to the isolated test DB");
  process.exit(2);
}
const PORT = process.env.TEST_PORT ?? String(3100 + Math.floor(Math.random() * 800));
const API = `http://localhost:${PORT}/api`;
const RUNNER_TOKEN = `tok-${randomUUID()}`;

const pool = new pg.Pool({ connectionString: TEST_DB });

let passed = 0;
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

async function seed() {
  // Clean slate for repeatable runs.
  await pool.query(
    `truncate schedules, agent_inbox, messages, channel_members, channels, participants, workspaces restart identity cascade`,
  );
  const ws = (await pool.query(`insert into workspaces (name) values ('test-ws') returning id`)).rows[0].id;
  const human = (
    await pool.query(
      `insert into participants (kind, handle, display_name, mode, effort, runtime, workspace_id, role)
       values ('human','sahil','Sahil','default','medium','human',$1,'admin') returning id`,
      [ws],
    )
  ).rows[0].id;
  const agent = (
    await pool.query(
      `insert into participants (kind, handle, display_name, mode, effort, runtime, runner_provider, runner_token, workspace_id, role)
       values ('agent','robo','Robo','default','medium','sdk','fly',$2,$1,'member') returning id`,
      [ws, RUNNER_TOKEN],
    )
  ).rows[0].id;
  const channel = (
    await pool.query(`insert into channels (name, kind, workspace_id) values ('general','channel',$1) returning id`, [ws])
  ).rows[0].id;
  await pool.query(
    `insert into channel_members (channel_id, participant_id) values ($1,$2),($1,$3)`,
    [channel, human, agent],
  );
  return { ws, human, agent, channel };
}

// ---- fake runner ----
function startFakeRunner(onEnqueue) {
  const url = `ws://localhost:${PORT}/api/runner?token=${encodeURIComponent(RUNNER_TOKEN)}`;
  const sock = new WebSocket(url);
  const sessionId = `fake-${Date.now().toString(36)}`;
  let turnN = 0;
  const send = (o) => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify(o));
  sock.on("open", () => send({ type: "hello", agentId: "x", sessionId, protocol: 1 }));
  sock.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.type === "configure") {
      send({ type: "state", state: "idle", sessionId, model: f.model, permissionMode: f.permissionMode });
    }
    if (f.type === "enqueue") {
      const inboxIds = (f.items || []).map((i) => i.inboxId);
      const turnId = `turn-${++turnN}`;
      send({ type: "turn_started", turnId, inboxIds });
      send({ type: "consumed", inboxIds, turnId });
      onEnqueue?.({ items: f.items, inboxIds, turnId, send });
    }
  });
  return { sock, close: () => sock.close() };
}

async function req(method, path, body) {
  const res = await fetch(`${API}${path}?participantId=${SEED.human}`, {
    method,
    headers: { "content-type": "application/json", "x-workspace-id": SEED.ws },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

let SEED;
let backend;

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("backend did not become healthy");
}

async function main() {
  SEED = await seed();

  backend = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      DATABASE_URL: TEST_DB,
      PORT,
      AUTH_DEV_BYPASS: "1",
      SCHEDULER_TICK_MS: "700",
      // Neutralize Fly so boot reconciliation can't touch real machines (empty token → API
      // calls fail → caught). The fake runner stays connected, so wake-on-message never fires.
      FLY_API_TOKEN: "",
      FLY_APP: "test-noop",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[be] ${d}`));
  backend.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[be] ${d}`));
  await waitHealth();

  // ---- Test 2 first (no runner needed): validation ----
  console.log("\nvalidation:");
  const base = { agentId: SEED.agent, channelId: SEED.channel, prompt: "do a thing" };
  ok("dense cron rejected", (await req("POST", "/schedules", { ...base, cron: "* * * * *", timezone: "UTC" })).status === 400);
  ok("bad timezone rejected", (await req("POST", "/schedules", { ...base, cron: "0 9 * * *", timezone: "Mars/Phobos" })).status === 400);
  ok("past runAt rejected", (await req("POST", "/schedules", { ...base, runAt: "2000-01-01T00:00:00Z" })).status === 400);
  ok("both cadences rejected", (await req("POST", "/schedules", { ...base, cron: "0 9 * * *", timezone: "UTC", runAt: new Date(Date.now() + 1e6).toISOString() })).status === 400);
  ok("over-long prompt rejected", (await req("POST", "/schedules", { ...base, prompt: "x".repeat(4001), runAt: new Date(Date.now() + 1e6).toISOString() })).status === 400);

  // ---- Test 1: one-shot fire ----
  console.log("\none-shot fire:");
  let firedEnqueue = null;
  const runner = startFakeRunner((e) => {
    if (e.items?.[0]?.text?.includes("UNIQUE-MARKER-ONESHOT")) firedEnqueue = e;
    // Finish the turn ok so attribution records success.
    e.send({ type: "turn_done", turnId: e.turnId, ok: true });
  });
  await sleep(500); // let hello/configure settle
  const createRes = await req("POST", "/schedules", {
    ...base,
    prompt: "Post UNIQUE-MARKER-ONESHOT to the channel.",
    runAt: new Date(Date.now() + 1500).toISOString(),
  });
  ok("one-shot created (201)", createRes.status === 201, JSON.stringify(createRes.json));
  const schedId = createRes.json.id;

  // Wait for the ticker to fire it.
  for (let i = 0; i < 20 && !firedEnqueue; i++) await sleep(300);
  ok("fake runner received the scheduled prompt", !!firedEnqueue);

  const row = (await pool.query(`select * from schedules where id=$1`, [schedId])).rows[0];
  ok("one-shot next_run_at cleared (advance-before-dispatch)", row.next_run_at === null);
  ok("last_run_at set", row.last_run_at !== null);

  // Context-fix + attribution: the fired inbox item carries the scheduleId and a turn_id.
  await sleep(600);
  const inbox = (
    await pool.query(
      `select context, turn_id from agent_inbox where agent_id=$1 and context ? 'scheduleId' order by created_at desc limit 1`,
      [SEED.agent],
    )
  ).rows[0];
  ok("inbox item context carries scheduleId", inbox?.context?.scheduleId === schedId);
  ok("inbox item turn_id stamped", !!inbox?.turn_id);
  const after = (await pool.query(`select last_status from schedules where id=$1`, [schedId])).rows[0];
  ok("one-shot last_status success after ok turn", after.last_status === "success");

  runner.close();
  await sleep(300);

  // ---- Test 3: auto-pause after 3 consecutive failures ----
  console.log("\nauto-pause on repeated failure:");
  // A cron schedule; we drive its next_run_at back to now() between fires and fail each turn.
  const cronRes = await req("POST", "/schedules", {
    ...base,
    prompt: "FAILING-SCHEDULE that always errors",
    cron: "0 9 * * *",
    timezone: "UTC",
  });
  const failId = cronRes.json.id;
  const failRunner = startFakeRunner((e) => {
    const t0 = e.items?.[0]?.text?.slice(0, 40);
    console.log(`    [failRunner] enqueue turn=${e.turnId} items=${e.items?.length} text0="${t0}"`);
    if (e.items?.[0]?.text?.includes("FAILING-SCHEDULE")) {
      e.send({ type: "turn_done", turnId: e.turnId, ok: false, error: "boom" });
    } else {
      e.send({ type: "turn_done", turnId: e.turnId, ok: true });
    }
  });
  await sleep(400);
  // Drive three failing fires. Each: force it due, then poll until the failure is attributed
  // (failure_count advances) or it gets auto-paused — no fixed-sleep flakiness.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await pool.query(`update schedules set next_run_at = now() where id=$1 and paused_at is null`, [failId]);
    let st;
    for (let i = 0; i < 30; i++) {
      st = (await pool.query(`select failure_count, paused_at, last_status from schedules where id=$1`, [failId])).rows[0];
      if (st.failure_count >= attempt || st.paused_at) break;
      await sleep(200);
    }
    console.log(`    attempt ${attempt}: failure_count=${st.failure_count} last_status=${st.last_status} paused=${!!st.paused_at}`);
    if (st.paused_at) break;
  }
  const failRow = (await pool.query(`select failure_count, paused_at, last_status from schedules where id=$1`, [failId])).rows[0];
  ok("failure_count reached 3", failRow.failure_count >= 3, `got ${failRow.failure_count}`);
  ok("schedule auto-paused", failRow.paused_at !== null);
  const notice = (
    await pool.query(
      `select count(*)::int as n from messages where channel_id=$1 and sender_id=$2 and body like '%paused my schedule%'`,
      [SEED.channel, SEED.agent],
    )
  ).rows[0].n;
  ok("pause notice posted to channel", notice >= 1, `got ${notice}`);
  failRunner.close();

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((e) => {
    console.error(e);
    failed++;
  })
  .finally(async () => {
    backend?.kill("SIGKILL");
    await pool.end().catch(() => {});
    process.exit(failed ? 1 : 0);
  });
