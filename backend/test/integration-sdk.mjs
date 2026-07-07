// End-to-end integration: real backend (test port) <-> real jungle-runner container.
// Drives the API as a dev-bypass human, DMs a freshly created sdk agent, and checks:
//   1. agent replies via send_message         2. Bash tool -> confirmation card -> allow
//   3. rapid double-message both consumed     4. interrupt stops a long turn
// Run:  node test/integration-sdk.mjs <backendPort> <humanParticipantId>
// Assumes the backend is already running on that port with AUTH_DEV_BYPASS=1.
import WebSocket from "ws";

const PORT = process.argv[2] ?? "3002";
const HUMAN = process.argv[3];
if (!HUMAN) throw new Error("usage: node integration-sdk.mjs <port> <humanParticipantId>");
const API = `http://localhost:${PORT}/api`;
const HANDLE = `itest-${Date.now().toString(36).slice(-4)}`;

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

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- collectors fed by the app WS ---
const waiters = []; // {match: fn, resolve}
const seen = [];
function waitFor(name, match, timeoutMs = 120_000) {
  const hit = seen.find(match);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
    waiters.push({ match, resolve: (f) => { clearTimeout(t); resolve(f); } });
  });
}

async function main() {
  // 1. create the sdk agent (default = prompting mode, cheap model)
  const agent = await api("POST", "/agents", {
    handle: HANDLE, displayName: "Integration Test",
    mode: "default", model: "claude-haiku-4-5-20251001",
    participantId: HUMAN,
  });
  check("create sdk agent", agent.runtime === "sdk" && !agent.runner_token,
    `id=${agent.id} runtime=${agent.runtime} tokenLeaked=${!!agent.runner_token}`);

  // 2. DM channel + app WS
  const dm = await api("POST", "/dms", { participantId: HUMAN, otherId: agent.id });
  const ws = new WebSocket(`ws://localhost:${PORT}?participantId=${HUMAN}`);
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    seen.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(f)) waiters.splice(i, 1)[0].resolve(f);
    }
  });
  await new Promise((r) => ws.on("open", r));
  const post = (body) => ws.send(JSON.stringify({ type: "post", channelId: dm.id, body }));
  // seq is a bigint serialized as a STRING — compare numerically ("10" > "7" is false as
  // strings, which silently broke matches once a channel passed seq 9).
  const agentMsg = (after, substr) => (f) =>
    f.type === "message" && f.message?.sender_id === agent.id &&
    Number(f.message?.seq) > Number(after) &&
    (!substr || f.message.body.toLowerCase().includes(substr));

  // give the container time to boot + hello/configure
  log("waiting 20s for container boot…");
  await new Promise((r) => setTimeout(r, 20_000));

  // 3. basic reply via send_message
  post(`@${HANDLE} reply with exactly the word: pineapple`);
  const reply = await waitFor("agent reply", agentMsg(0, "pineapple"));
  check("agent replies via send_message", true, JSON.stringify(reply.message.body).slice(0, 60));

  // events flowing?
  check("agent_event frames broadcast", seen.some((f) => f.type === "agent_event" && f.agentId === agent.id));

  // 4. Bash tool -> confirmation card (default mode must prompt)
  const seqBeforeBash = reply.message.seq;
  post(`@${HANDLE} run the shell command \`echo jungle-ok\` with your Bash tool, then tell me its output.`);
  const card = await waitFor("confirmation card",
    (f) => f.type === "tool_confirmation_request" && f.agentId === agent.id);
  check("Bash prompts a confirmation card", card.tool?.toLowerCase().includes("bash"), `tool=${card.tool}`);
  await api("POST", "/agents/confirm", { confirmId: card.confirmId, decision: "allow", participantId: HUMAN });
  const bashReply = await waitFor("post-bash reply", agentMsg(seqBeforeBash, "jungle-ok"));
  check("allowed Bash ran + agent reported output", true, JSON.stringify(bashReply.message.body).slice(0, 60));

  // 5. rapid double message -> both handled (batched or sequential)
  const seqBefore2 = bashReply.message.seq;
  post(`@${HANDLE} FIRST: what is 2+2? reply including the word four.`);
  post(`@${HANDLE} SECOND: what color is the sky? reply including the word blue.`);
  await waitFor("answer #1", agentMsg(seqBefore2, "four"));
  await waitFor("answer #2", agentMsg(seqBefore2, "blue"));
  check("rapid double message: both answered", true);

  // 6. interrupt a long turn. NOTE: the Claude CLI hard-blocks standalone `sleep N`
  // before the permission layer (no confirm card would ever surface), so use a loop.
  post(`@${HANDLE} using Bash run exactly \`for i in $(seq 1 90); do echo tick $i; sleep 1; done\` (a slow counting loop) and only reply after it finishes.`);
  const card2 = await waitFor("slow-loop confirm card",
    (f) => f.type === "tool_confirmation_request" && f.agentId === agent.id &&
           JSON.stringify(f.input ?? "").includes("seq 1 90"));
  await api("POST", "/agents/confirm", { confirmId: card2.confirmId, decision: "allow", participantId: HUMAN });
  await new Promise((r) => setTimeout(r, 5_000)); // let the sleep start
  const intr = await api("POST", `/agents/${agent.id}/interrupt`, { participantId: HUMAN });
  check("interrupt delivered", intr.ok === true, JSON.stringify(intr));
  const done = await waitFor("turn end after interrupt",
    (f) => f.type === "agent_event" && f.agentId === agent.id && f.event?.type === "result", 60_000);
  check("interrupted turn ended promptly", true, `subtype=${done.event?.subtype}`);

  // 7. history endpoint
  const hist = await api("GET", `/agents/${agent.id}/events?participantId=${HUMAN}&limit=50`);
  check("events history endpoint", Array.isArray(hist.events) && hist.events.length > 0 && !!hist.runner,
    `events=${hist.events?.length} runner=${JSON.stringify(hist.runner)}`);

  ws.close();
  log(`DONE: ${pass} passed, ${fail} failed  (agent=${agent.id} handle=@${HANDLE} dm=${dm.id})`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(2); });
