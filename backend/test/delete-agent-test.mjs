// Validates DELETE /api/agents/:id end to end against a real container.
// Creates a throwaway sdk agent, gets it to send a message (exercises the messages.sender_id
// RESTRICT delete path), then deletes it and asserts: WS participant_deleted broadcast,
// participant gone from the API, and container+volume torn down.
// Run:  node test/delete-agent-test.mjs <port> <humanParticipantId>
import WebSocket from "ws";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const PORT = process.argv[2] ?? "3011";
const HUMAN = process.argv[3];
if (!HUMAN) throw new Error("usage: node delete-agent-test.mjs <port> <humanParticipantId>");
const API = `http://localhost:${PORT}/api`;
const HANDLE = `deltest-${Date.now().toString(36).slice(-4)}`;

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
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const dockerSoft = async (args) => {
  try { const { stdout } = await execFileAsync("sg", ["docker", "-c", `docker ${args.join(" ")}`]); return stdout.trim(); }
  catch { return ""; }
};

const seen = [];
const waiters = [];
function waitFor(name, match, timeoutMs = 120_000) {
  const hit = seen.find(match);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
    waiters.push({ match, resolve: (f) => { clearTimeout(t); resolve(f); } });
  });
}

async function main() {
  const agent = await api("POST", "/agents", { handle: HANDLE, displayName: "Delete Test", mode: "default", model: "claude-haiku-4-5-20251001" });
  const cname = `jungle-agent-${agent.id}`;
  const vname = `jungle-agent-${agent.id}-ws`;
  check("agent created", !!agent.id, `id=${agent.id}`);

  // container should exist
  await new Promise((r) => setTimeout(r, 2000));
  const existsBefore = await dockerSoft(["inspect", "-f", "{{.State.Running}}", cname]);
  check("container provisioned", existsBefore !== "", `running=${existsBefore}`);

  const dm = await api("POST", "/dms", { participantId: HUMAN, otherId: agent.id });
  const ws = new WebSocket(`ws://localhost:${PORT}?participantId=${HUMAN}`);
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    seen.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].match(f)) waiters.splice(i, 1)[0].resolve(f);
  });
  await new Promise((r) => ws.on("open", r));

  log("waiting 20s for container boot…");
  await new Promise((r) => setTimeout(r, 20_000));
  ws.send(JSON.stringify({ type: "post", channelId: dm.id, body: `@${HANDLE} reply with exactly the word: banana` }));
  await waitFor("agent reply", (f) => f.type === "message" && f.message?.sender_id === agent.id && f.message.body.toLowerCase().includes("banana"));
  check("agent sent a message (RESTRICT delete path will be exercised)", true);

  // DELETE
  const del = await api("DELETE", `/agents/${agent.id}?participantId=${HUMAN}`);
  check("DELETE returns ok", del.ok === true, JSON.stringify(del));

  // WS broadcast
  const gone = await waitFor("participant_deleted", (f) => f.type === "participant_deleted" && f.participantId === agent.id, 15_000);
  check("participant_deleted broadcast received", !!gone);

  // participant gone from API
  const parts = await api("GET", "/participants");
  check("participant removed from /participants", !parts.some((p) => p.id === agent.id));

  // container + volume torn down (allow a moment for docker rm)
  await new Promise((r) => setTimeout(r, 2000));
  const existsAfter = await dockerSoft(["inspect", "-f", "{{.State.Running}}", cname]);
  check("container destroyed", existsAfter === "", `inspect=${JSON.stringify(existsAfter)}`);
  const volAfter = await dockerSoft(["volume", "inspect", vname]);
  check("volume destroyed", volAfter === "", `volInspect=${volAfter.slice(0, 40)}`);

  ws.close();
  log(`DONE: ${pass} passed, ${fail} failed  (agent=${agent.id} dm=${dm.id})`);
  console.log(`CLEANUP_AGENT=${agent.id}`);
  console.log(`CLEANUP_DM=${dm.id}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(2); });
