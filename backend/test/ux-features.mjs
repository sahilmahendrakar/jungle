// End-to-end for the UX-overhaul backend features, against a dev-bypass backend (test port) and
// a scripted fake runner (no real Agent SDK):
//   1. agent send_message is stamped with the turn that produced it (messages.turn_id)
//   2. a PR link in the agent's reply lands in the deliverables feed (+ deliverable_created fan-out)
//   3. GET /api/search finds the message via FTS, scoped to my channels
//   4. confirm_request -> GET /api/confirmations lists it -> allow resolves the runner's wait
// Usage: node test/ux-features.mjs <backendPort> <humanParticipantId>
import WebSocket from "ws";

const PORT = process.argv[2] ?? "3003";
const HUMAN = process.argv[3];
if (!HUMAN) throw new Error("usage: node ux-features.mjs <port> <humanParticipantId>");
const API = `http://localhost:${PORT}/api`;
const HANDLE = `uxtest-${Date.now().toString(36).slice(-4)}`;
const PR_URL = `https://github.com/acme/app/pull/${Date.now() % 10_000}`;

const api = async (method, path, body) => {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${API}${path}${sep}participantId=${HUMAN}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(j)}`);
  return j;
};

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- app WS: collect frames, await matches ---
const seen = [];
const waiters = [];
function waitFor(name, match, timeoutMs = 15_000) {
  const hit = seen.find(match);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
    waiters.push({ match, resolve: (f) => { clearTimeout(t); resolve(f); } });
  });
}
const appWs = new WebSocket(`ws://localhost:${PORT}/?participantId=${HUMAN}`);
appWs.on("message", (raw) => {
  const f = JSON.parse(raw.toString());
  seen.push(f);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].match(f)) waiters.splice(i, 1)[0].resolve(f);
  }
});
await new Promise((res) => appWs.on("open", res));

// --- create agent (provisioning fails harmlessly without docker; the row is what we need) ---
const agent = await api("POST", "/agents", { handle: HANDLE, displayName: "UX Test Agent" });
const dm = await api("POST", "/dms", { participantId: HUMAN, otherId: agent.id });

// The runner token never leaves the API; the test reads it straight from the DB.
const { execSync } = await import("node:child_process");
const dbUrl = process.env.DATABASE_URL;
const runnerToken = execSync(
  `psql "${dbUrl}" -tAc "select runner_token from participants where id = '${agent.id}'"`,
).toString().trim();
if (!runnerToken) throw new Error("no runner token");

// --- fake runner: on the dispatch, reply with a PR link + emit an event + request a confirm ---
const TURN = `turn-ux-${Date.now().toString(36)}`;
let confirmResult = null;
const runner = new WebSocket(`ws://localhost:${PORT}/api/runner?token=${runnerToken}`);
runner.on("open", () => runner.send(JSON.stringify({ type: "hello", agentId: "x", sessionId: "s1", protocol: 1 })));
runner.on("message", (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.type === "configure") {
    runner.send(JSON.stringify({ type: "state", state: "idle", sessionId: "s1" }));
  }
  if (f.type === "enqueue") {
    const inboxIds = (f.items || []).map((i) => i.inboxId);
    // The dispatch prompt names the reply destination as #<channel> (DMs included).
    const to = (f.items?.[0]?.text || "").match(/#([a-zA-Z0-9_-]+)/)?.[0];
    runner.send(JSON.stringify({ type: "turn_started", turnId: TURN, inboxIds }));
    runner.send(JSON.stringify({ type: "consumed", inboxIds, turnId: TURN }));
    runner.send(JSON.stringify({
      type: "event",
      turnId: TURN,
      event: { type: "assistant", message: { content: [{ type: "text", text: "opening the PR" }] } },
    }));
    runner.send(JSON.stringify({
      type: "send_message",
      id: "sm-1",
      input: { to, body: `Done! Opened [Fix the login flow](${PR_URL}) for review.` },
    }));
    runner.send(JSON.stringify({
      type: "confirm_request",
      id: "cf-1",
      toolName: "Bash",
      input: { command: "rm -rf /tmp/scratch" },
    }));
    setTimeout(() => runner.send(JSON.stringify({ type: "turn_done", turnId: TURN, ok: true })), 4000);
  }
  if (f.type === "confirm_result") confirmResult = f;
});

// Give hello/configure a beat, then drive the flow from the human side.
await new Promise((res) => setTimeout(res, 1200));
appWs.send(JSON.stringify({ type: "post", channelId: dm.id, body: `@${HANDLE} please open that PR` }));

const agentMsg = await waitFor(
  "agent reply",
  (f) => f.type === "message" && f.message?.sender_handle === HANDLE,
);
check("agent reply carries turn_id", agentMsg.message.turn_id === TURN, `got ${agentMsg.message.turn_id}`);

const delivEvt = await waitFor("deliverable_created", (f) => f.type === "deliverable_created");
check(
  "deliverable extracted from the PR link",
  delivEvt.deliverable?.kind === "github_pr" && delivEvt.deliverable?.url === PR_URL,
  delivEvt.deliverable?.url,
);
check("deliverable carries the markdown title", delivEvt.deliverable?.title === "Fix the login flow");

const feed = await api("GET", "/deliverables");
check("GET /api/deliverables lists it", feed.deliverables?.some((d) => d.url === PR_URL));

// 3: FTS search finds the agent's message.
const search = await api("GET", `/search?q=${encodeURIComponent("login flow review")}`);
check(
  "GET /api/search finds the message",
  search.results?.some((r) => r.body.includes(PR_URL)),
  `${search.results?.length ?? 0} hits`,
);

// 4: the confirm surfaced -> listed -> allow resolves the runner's wait.
const confirmEvt = await waitFor("tool_confirmation_request", (f) => f.type === "tool_confirmation_request");
check("confirm card fanned out", confirmEvt.tool === "Bash");
const pending = await api("GET", "/confirmations");
check(
  "GET /api/confirmations lists the pending confirm",
  pending.confirmations?.some((c) => c.confirmId === confirmEvt.confirmId && c.tool === "Bash" && c.agentHandle === HANDLE),
);
await api("POST", "/agents/confirm", { confirmId: confirmEvt.confirmId, decision: "allow" });
await waitFor("tool_confirmation_resolved", (f) => f.type === "tool_confirmation_resolved" && f.result === "allow");
await new Promise((res) => setTimeout(res, 500));
check("runner received confirm_result allow", confirmResult?.result === "allow");
const pendingAfter = await api("GET", "/confirmations");
check("confirm no longer listed after resolve", !pendingAfter.confirmations?.some((c) => c.confirmId === confirmEvt.confirmId));

console.log(`\n${pass} passed, ${fail} failed`);
runner.close();
appWs.close();
process.exit(fail ? 1 : 0);
