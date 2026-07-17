// workflows-test.mjs — end-to-end test of the workflows feature against an ISOLATED test DB.
//
// Boots the backend (dev-bypass, fast ticker) with Fly neutralized, and asserts the whole v1
// lifecycle with a fake runner standing in for the member agent:
//   1. template -> draft -> finalize: member agent + home channel + backing schedule created.
//   2. manual run: run row + run-header message (thread anchor) + kickoff enqueue whose inbox
//      context carries workflowRunId; a second Run-now 409s (one live run per workflow).
//   3. completion: the agent's "Run complete: …" thread message flips the run to done with the
//      summary captured.
//   4. cron trigger: forcing the backing schedule due makes the ticker start a run with
//      trigger='schedule' (the workflow branch, not a plain agent turn).
//
// Run (after creating the DB + applying schema, same harness as schedules-test.mjs):
//   set -a; . ../../.env; set +a
//   TEST_DATABASE_URL="${DATABASE_URL%/*}/jungle_wf_test" node backend/test/workflows-test.mjs

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { WebSocket } from "ws";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  console.error("set TEST_DATABASE_URL to the isolated test DB");
  process.exit(2);
}
const PORT = process.env.TEST_PORT ?? String(3100 + Math.floor(Math.random() * 800));
const API = `http://localhost:${PORT}/api`;

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
  await pool.query(
    `truncate workflow_runs, workflows, schedules, agent_inbox, agent_events, messages,
       channel_members, channels, participants, workspaces restart identity cascade`,
  );
  const ws = (await pool.query(`insert into workspaces (name) values ('test-ws') returning id`)).rows[0].id;
  const human = (
    await pool.query(
      `insert into participants (kind, handle, display_name, mode, effort, runtime, workspace_id, role)
       values ('human','sahil','Sahil','default','medium','human',$1,'admin') returning id`,
      [ws],
    )
  ).rows[0].id;
  return { ws, human };
}

function startFakeRunner(token, onEnqueue) {
  const url = `ws://localhost:${PORT}/api/runner?token=${encodeURIComponent(token)}`;
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

async function waitFor(name, fn, timeoutMs = 15_000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${name}`);
    await sleep(300);
  }
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
      FLY_API_TOKEN: "",
      FLY_APP: "test-noop",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  backend.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[be] ${d}`));
  backend.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[be] ${d}`));
  await waitHealth();

  // ---- 1. template -> draft -> finalize ----
  console.log("\nfinalize:");
  const draft = (await req("POST", "/workflows", { templateId: "standup-digest" })).json;
  ok("draft created from template", draft.status === "draft" && draft.roster?.length === 1, JSON.stringify(draft).slice(0, 200));

  const fin = await req("POST", `/workflows/${draft.id}/finalize`, {});
  ok("finalize -> active", fin.status === 200 && fin.json.status === "active", JSON.stringify(fin.json).slice(0, 200));
  ok("home channel set", !!fin.json.home_channel_id);
  ok("roster bound", !!fin.json.roster?.[0]?.participant_id);

  const agentRow = (
    await pool.query(`select id, handle, runner_token from participants where id = $1`, [
      fin.json.roster[0].participant_id,
    ])
  ).rows[0];
  ok("member agent created (@daily)", agentRow?.handle === "daily", agentRow?.handle);

  const backing = (
    await pool.query(`select * from schedules where workflow_id = $1`, [draft.id])
  ).rows[0];
  ok("backing schedule exists with next_run_at", !!backing?.next_run_at);

  const chan = (
    await pool.query(`select name from channels where id = $1`, [fin.json.home_channel_id])
  ).rows[0];
  ok("home channel named from workflow", chan?.name === "daily-standup-digest", chan?.name);

  // ---- 2. manual run ----
  console.log("\nmanual run:");
  const enqueues = [];
  let runnerSend = null;
  const runner = startFakeRunner(agentRow.runner_token, ({ items, turnId, send }) => {
    enqueues.push({ items, turnId, send });
    runnerSend = send;
  });
  await sleep(1200); // hello/configure settle

  const run1 = await req("POST", `/workflows/${draft.id}/run`, {});
  ok("run started", run1.status === 201 && run1.json.status === "running", JSON.stringify(run1.json).slice(0, 200));

  const kicked = await waitFor("kickoff enqueue", async () => enqueues[0]);
  ok("kickoff prompt mentions workflow run", /WORKFLOW RUN kickoff/.test(kicked.items[0]?.text ?? ""));

  const inboxCtx = (
    await pool.query(
      `select context from agent_inbox where agent_id = $1 order by created_at desc limit 1`,
      [agentRow.id],
    )
  ).rows[0]?.context;
  ok("inbox context carries workflowRunId", inboxCtx?.workflowRunId === run1.json.id, JSON.stringify(inboxCtx));

  const header = (
    await pool.query(
      `select id, body, thread_root_id from messages where channel_id = $1 order by seq limit 1`,
      [fin.json.home_channel_id],
    )
  ).rows[0];
  ok("run-header message posted", /run started/.test(header?.body ?? ""), header?.body);

  const overlap = await req("POST", `/workflows/${draft.id}/run`, {});
  ok("second Run-now 409s while live", overlap.status === 409, String(overlap.status));

  // ---- 3. completion via "Run complete:" thread message ----
  console.log("\ncompletion:");
  runnerSend({
    type: "send_message",
    id: "sm-1",
    input: { to: "#daily-standup-digest", body: "Run complete: nothing to report today." },
  });
  runnerSend({ type: "turn_done", turnId: kicked.turnId, ok: true });

  const doneRun = await waitFor("run done", async () => {
    const r = (await pool.query(`select * from workflow_runs where id = $1`, [run1.json.id])).rows[0];
    return r?.status === "done" ? r : null;
  });
  ok("run completed with summary", doneRun.summary === "nothing to report today.", doneRun.summary);

  const threadMsg = (
    await pool.query(`select thread_root_id from messages where channel_id = $1 and body like 'Run complete%'`, [
      fin.json.home_channel_id,
    ])
  ).rows[0];
  ok("completion message landed in the run thread", threadMsg?.thread_root_id === header?.id);

  // ---- 4. cron trigger -> workflow run (ticker branch) ----
  console.log("\ncron trigger:");
  await pool.query(`update schedules set next_run_at = now() where workflow_id = $1`, [draft.id]);
  const run2 = await waitFor("scheduled run", async () => {
    const r = (
      await pool.query(
        `select * from workflow_runs where workflow_id = $1 and trigger = 'schedule' limit 1`,
        [draft.id],
      )
    ).rows[0];
    return r ?? null;
  });
  ok("ticker started a workflow run (not a plain turn)", run2.status === "running" || run2.status === "done");
  const backing2 = (
    await pool.query(`select next_run_at from schedules where workflow_id = $1`, [draft.id])
  ).rows[0];
  ok("backing schedule advanced", !!backing2?.next_run_at && new Date(backing2.next_run_at) > new Date());

  runner.close();
  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main()
  .catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  })
  .finally(() => {
    backend?.kill();
    void pool.end();
  });
