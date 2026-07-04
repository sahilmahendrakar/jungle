// Workspace isolation regression. Spins up two workspaces via the dev-only /api/_dev/workspaces
// route and asserts a member of workspace B can never see, reach, or receive anything from
// workspace A — over REST and over the app WebSocket. No runner / Anthropic calls needed.
//
// Run:  node test/tenancy.mjs <backendPort>
// Assumes the backend is already running on that port with AUTH_DEV_BYPASS=1 and (ideally)
// MAX_AGENTS_PER_WORKSPACE=2 so the agent-cap assertion is cheap.
import WebSocket from "ws";

const PORT = process.argv[2] ?? "3009";
const API = `http://localhost:${PORT}/api`;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// Raw fetch that returns { status, json } (never throws on non-2xx — we assert on status).
async function api(method, path, body, as) {
  const url = `${API}${path}`;
  const r = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body || as ? JSON.stringify({ ...(body ?? {}), ...(as ? { participantId: as } : {}) }) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}
// GET with dev participantId in the query string.
async function get(path, as) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${API}${path}${as ? `${sep}participantId=${as}` : ""}`);
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

// Collect app-WS frames per connection so we can assert what each side did / didn't receive.
function openWs(participantId) {
  const seen = [];
  const ws = new WebSocket(`ws://localhost:${PORT}?participantId=${participantId}`);
  ws.on("message", (raw) => {
    try { seen.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
  });
  const ready = new Promise((res, rej) => {
    ws.on("open", () => res());
    ws.on("error", rej);
  });
  return { ws, seen, ready };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const stamp = Date.now().toString(36).slice(-4);
  // Two isolated workspaces, each with an admin human.
  const a = await api("POST", "/_dev/workspaces", { name: `A-${stamp}`, handle: `alice${stamp}` });
  const b = await api("POST", "/_dev/workspaces", { name: `B-${stamp}`, handle: `bob${stamp}` });
  check("create workspace A", a.status === 201, `status=${a.status}`);
  check("create workspace B", b.status === 201, `status=${b.status}`);
  const A = a.json.participant.id, B = b.json.participant.id;
  const wsA = a.json.workspace.id, wsB = b.json.workspace.id;
  check("distinct workspaces", wsA !== wsB);

  // A creates a channel + an agent in workspace A.
  const chA = await api("POST", "/channels", { name: `secret-${stamp}`, kind: "channel" }, A);
  check("A creates channel", chA.status === 201, `status=${chA.status}`);
  const chAId = chA.json.id;
  const agA = await api("POST", "/agents", { handle: `agentA${stamp}`, displayName: "Agent A", mode: "default" }, A);
  check("A creates agent", agA.status === 201, `status=${agA.status}`);
  const agentAId = agA.json.id;

  // --- REST isolation: B cannot see or reach anything in A ---
  const bPeople = await get("/participants", B);
  const bHandles = (bPeople.json ?? []).map((p) => p.handle);
  check("B's people list excludes A's members/agents", bPeople.status === 200 && !bHandles.some((h) => h.includes(stamp) && (h.startsWith("alice") || h.startsWith("agentA"))), JSON.stringify(bHandles));
  check("B cannot read A's channel messages (404)", (await get(`/channels/${chAId}/messages`, B)).status === 404);
  check("A can read A's channel messages (200)", (await get(`/channels/${chAId}/messages`, A)).status === 200);
  check("B cannot fetch A's agent events (404)", (await get(`/agents/${agentAId}/events`, B)).status === 404);
  check("B cannot interrupt A's agent (404)", (await api("POST", `/agents/${agentAId}/interrupt`, {}, B)).status === 404);
  check("B cannot delete A's agent (404)", (await api("DELETE", `/agents/${agentAId}`, {}, B)).status === 404);
  check("B cannot DM A's admin across workspaces", (await api("POST", "/dms", { otherId: A }, B)).status >= 400);

  // --- WS isolation: a workspace-wide broadcast in A must not reach B ---
  const cA = openWs(A), cB = openWs(B);
  await Promise.all([cA.ready, cB.ready]);
  await sleep(200);
  // PATCH A's agent -> participant_updated broadcast to workspace A only (no runner needed).
  const patch = await api("PATCH", `/agents/${agentAId}`, { displayName: "Agent A v2" }, A);
  check("A patches its agent", patch.status === 200, `status=${patch.status}`);
  await sleep(400);
  const aGotUpdate = cA.seen.some((f) => f.type === "participant_updated" && f.participant?.id === agentAId);
  const bGotUpdate = cB.seen.some((f) => f.type === "participant_updated" && f.participant?.id === agentAId);
  check("A's socket received the agent update", aGotUpdate);
  check("B's socket did NOT receive A's agent update (no cross-workspace leak)", !bGotUpdate);
  cA.ws.close(); cB.ws.close();

  // --- Agent cap: creating past the workspace cap is rejected ---
  // (Assumes MAX_AGENTS_PER_WORKSPACE=2; A already has 1 agent.)
  const cap2 = await api("POST", "/agents", { handle: `agentA2${stamp}`, displayName: "A2", mode: "default" }, A);
  const cap3 = await api("POST", "/agents", { handle: `agentA3${stamp}`, displayName: "A3", mode: "default" }, A);
  check("2nd agent allowed (under cap=2)", cap2.status === 201, `status=${cap2.status}`);
  check("3rd agent rejected with 409 (cap reached)", cap3.status === 409, `status=${cap3.status}`);

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
