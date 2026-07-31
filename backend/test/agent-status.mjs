// Agent self-set status (migrations/046) end-to-end at the PROTOCOL level: a fake runner drives
// `set_status` frames the way the real set_status tool would, so the whole path — frame handling,
// validation, persistence, the participant_updated broadcast, the serializer's expiry, and the
// backend->runner status_changed push — is exercised without an Agent SDK container or any token
// spend. (integration-sdk.mjs covers the real agent actually CALLING the tool.)
//
// Usage: TEST_DATABASE_URL=... node backend/test/agent-status.mjs <backendPort> <humanParticipantId>
// Assumes a dev-bypass backend on that port (AUTH_DEV_BYPASS=1) against that same database.
import WebSocket from "ws";
import pg from "pg";
import { randomUUID } from "node:crypto";

const PORT = process.argv[2] ?? "3055";
const HUMAN = process.argv[3];
const TEST_DB = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!HUMAN || !TEST_DB) {
  throw new Error("usage: TEST_DATABASE_URL=… node agent-status.mjs <port> <humanParticipantId>");
}
const API = `http://localhost:${PORT}/api`;
const HANDLE = `stest-${Date.now().toString(36).slice(-4)}`;
const RUNNER_TOKEN = `tok-${randomUUID()}`;
const pool = new pg.Pool({ connectionString: TEST_DB });

const api = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(j)}`);
  return j;
};

let pass = 0, fail = 0;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- frame collectors, one per socket ---
function collector() {
  const seen = [];
  const waiters = [];
  const push = (f) => {
    seen.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(f)) waiters.splice(i, 1)[0].resolve(f);
    }
  };
  const waitFor = (name, match, timeoutMs = 15_000) => {
    const hit = seen.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
      waiters.push({ match, resolve: (f) => { clearTimeout(t); resolve(f); } });
    });
  };
  return { seen, push, waitFor };
}

async function main() {
  // Seed the agent straight into the DB with a known runner_token (like schedules-test.mjs):
  // POST /agents would try to actually provision a container, which this test doesn't need — the
  // fake runner below IS the container, and it authenticates with this token.
  const { workspace_id } = (
    await pool.query(`select workspace_id from participants where id = $1`, [HUMAN])
  ).rows[0];
  const agent = (
    await pool.query(
      `insert into participants
         (kind, handle, display_name, mode, effort, runtime, runner_provider, runner_token,
          workspace_id, role)
       values ('agent',$1,'Status Test','bypassPermissions','medium','sdk','docker',$2,$3,'member')
       returning id`,
      [HANDLE, RUNNER_TOKEN, workspace_id],
    )
  ).rows[0];
  const token = RUNNER_TOKEN;

  // App socket: what a browser sees.
  const app = collector();
  const appWs = new WebSocket(`ws://localhost:${PORT}?participantId=${HUMAN}`);
  appWs.on("message", (raw) => app.push(JSON.parse(raw.toString())));
  await new Promise((r) => appWs.on("open", r));

  // Runner socket: what a container sends/receives.
  const run = collector();
  const runWs = new WebSocket(`ws://localhost:${PORT}/api/runner?token=${encodeURIComponent(token)}`);
  runWs.on("message", (raw) => run.push(JSON.parse(raw.toString())));
  await new Promise((r) => runWs.on("open", r));
  const send = (f) => runWs.send(JSON.stringify(f));
  send({ type: "hello", protocolVersion: 1, state: "idle" });

  const configure = await run.waitFor("configure", (f) => f.type === "configure");
  check("configure carries a status field (null for a fresh agent)", configure.status == null);

  // --- 1. set a status ---
  send({ type: "set_status", id: "s1", input: { text: "Fixing the login redirect", emoji: "🔧" } });
  const r1 = await run.waitFor("set_status_result", (f) => f.type === "set_status_result" && f.id === "s1");
  check("set_status succeeds", r1.result?.ok === true, JSON.stringify(r1.result));
  check(
    "result echoes what was stored (so the runner's cached copy can't drift)",
    r1.result?.status?.text === "Fixing the login redirect" &&
      r1.result?.status?.emoji === "🔧" &&
      !!r1.result?.status?.updatedAt,
    JSON.stringify(r1.result?.status),
  );
  const b1 = await app.waitFor(
    "participant_updated",
    (f) => f.type === "participant_updated" && f.participant?.id === agent.id && f.participant?.status_text,
  );
  check("status broadcasts to app clients", b1.participant.status_text === "Fixing the login redirect");
  check("broadcast strips runner_token", !b1.participant.runner_token);
  check("broadcast strips status_expires_at", !("status_expires_at" in b1.participant));
  // The agent set its OWN status — echoing status_changed back at it would be a pointless round
  // trip, and its tool result already carries the stored value.
  check(
    "no status_changed echoed back to the runner that set it",
    !run.seen.some((f) => f.type === "status_changed"),
  );

  // --- 2. validation ---
  send({ type: "set_status", id: "s2", input: { text: "x".repeat(101) } });
  const r2 = await run.waitFor("over-length result", (f) => f.type === "set_status_result" && f.id === "s2");
  check("over-length status is rejected", r2.result?.ok === false, JSON.stringify(r2.result?.error));
  const stillSet = await api("GET", `/participants?participantId=${HUMAN}`);
  check(
    "a rejected write leaves the previous status intact",
    stillSet.find((p) => p.id === agent.id)?.status_text === "Fixing the login redirect",
  );

  // --- 3. expiry is applied at READ time (no sweeper job) ---
  send({ type: "set_status", id: "s3", input: { text: "Short lived", clearAfterMinutes: 1 } });
  await run.waitFor("expiring set result", (f) => f.type === "set_status_result" && f.id === "s3");
  const withExpiry = (await api("GET", `/participants?participantId=${HUMAN}`)).find((p) => p.id === agent.id);
  check("an unexpired timed status is still served", withExpiry?.status_text === "Short lived");
  // Backdate the expiry rather than sleeping a minute: the row keeps its text, and the serializer
  // is the thing under test — an expired status must never leave the backend even though nothing
  // ever deleted it.
  await pool.query(`update participants set status_expires_at = now() - interval '1 minute' where id = $1`, [
    agent.id,
  ]);
  const expired = (await api("GET", `/participants?participantId=${HUMAN}`)).find((p) => p.id === agent.id);
  check(
    "an EXPIRED status is hidden on read, without being deleted",
    !expired.status_text && !expired.status_emoji && !expired.status_updated_at,
    JSON.stringify({ t: expired.status_text, e: expired.status_emoji, at: expired.status_updated_at }),
  );
  const stillInRow = (
    await pool.query(`select status_text from participants where id = $1`, [agent.id])
  ).rows[0];
  check("…and the row itself is untouched (read-time enforcement)", stillInRow.status_text === "Short lived");
  // A reconnecting runner must not be handed an expired status either.
  check(
    "selfStatusOf also drops an expired status",
    (await api("GET", `/participants?participantId=${HUMAN}`)).find((p) => p.id === agent.id).status_text == null,
  );

  // --- 4. clearing via the tool (empty text) ---
  send({ type: "set_status", id: "s4", input: { text: "" } });
  const r4 = await run.waitFor("clear result", (f) => f.type === "set_status_result" && f.id === "s4");
  check("empty text clears the status", r4.result?.ok === true && r4.result?.status == null, JSON.stringify(r4.result));
  const afterClear = (await api("GET", `/participants?participantId=${HUMAN}`)).find((p) => p.id === agent.id);
  check(
    "clear wipes text, emoji and timestamp together",
    !afterClear.status_text && !afterClear.status_emoji && !afterClear.status_updated_at,
    JSON.stringify({ t: afterClear.status_text, e: afterClear.status_emoji, at: afterClear.status_updated_at }),
  );

  // --- 5. a human clears it -> the runner MUST be told ---
  send({ type: "set_status", id: "s5", input: { text: "Waiting on PR review", emoji: "👀" } });
  await run.waitFor("re-set result", (f) => f.type === "set_status_result" && f.id === "s5");
  await api("DELETE", `/agents/${agent.id}/status?participantId=${HUMAN}`);
  const pushed = await run.waitFor("status_changed push", (f) => f.type === "status_changed");
  check("human clear pushes status_changed to the runner", pushed.status === null, JSON.stringify(pushed));
  const afterHumanClear = (await api("GET", `/participants?participantId=${HUMAN}`)).find((p) => p.id === agent.id);
  check("human clear wipes the row", !afterHumanClear.status_text);

  // --- 6. reconnect re-adopts the stored status ---
  send({ type: "set_status", id: "s6", input: { text: "Drafting the launch post", emoji: "📝" } });
  await run.waitFor("pre-reconnect set", (f) => f.type === "set_status_result" && f.id === "s6");
  runWs.close();
  await new Promise((r) => setTimeout(r, 500));
  const run2 = collector();
  const runWs2 = new WebSocket(`ws://localhost:${PORT}/api/runner?token=${encodeURIComponent(token)}`);
  runWs2.on("message", (raw) => run2.push(JSON.parse(raw.toString())));
  await new Promise((r) => runWs2.on("open", r));
  runWs2.send(JSON.stringify({ type: "hello", protocolVersion: 1, state: "idle" }));
  const configure2 = await run2.waitFor("configure on reconnect", (f) => f.type === "configure");
  check(
    "a reconnecting runner is handed the stored status back",
    configure2.status?.text === "Drafting the launch post" && configure2.status?.emoji === "📝",
    JSON.stringify(configure2.status),
  );
  check(
    "the system prompt teaches the agent about set_status",
    /set_status/.test(configure2.systemPromptAppend ?? ""),
  );

  runWs2.close();
  appWs.close();
  await pool.query(`delete from participants where id = $1`, [agent.id]);
  await pool.end();
  log(`DONE: ${pass} passed, ${fail} failed  (agent=${agent.id} handle=@${HANDLE})`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(2); });
