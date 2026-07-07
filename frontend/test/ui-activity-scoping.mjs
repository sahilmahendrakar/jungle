// UI e2e for the activity-scoping surfaces. Sets up a real channel + agent, connects a scripted
// fake runner, and drives a dispatch from the browser so a live turn is running with a known
// home channel. Verifies:
//   - trigger-message chip appears UNDER the message that asked (channel), and NOT the DM strip
//   - sidebar working-dot on the channel + header roster active-dot
//   - roster panel lists the agent as working
//   - agent hover card on the @mention
//   - a second channel (agent is a member, but idle there) shows NO chip / no dot — scoping holds
//   - when the turn finishes, the chip settles to "finished"
// Usage: node test/ui-activity-scoping.mjs <frontendUrl> <backendPort> <humanParticipantId>
import { chromium } from "playwright";
import WebSocket from "ws";
import { execSync } from "node:child_process";

const URL = process.argv[2];
const PORT = process.argv[3];
const HUMAN = process.argv[4];
const API = `http://localhost:${PORT}/api`;
const tag = Date.now().toString(36).slice(-4);
let fail = 0;
const check = (n, ok) => { console.log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) fail++; };
const shot = (p, n) => p.screenshot({ path: `/tmp/scoping-${n}.png` }).catch(() => {});

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

// --- setup: agent, two channels (both with the agent), a member human ---
const agent = await api("POST", "/agents", { handle: `sc-${tag}`, displayName: `Scope Agent ${tag}` });
const chA = await api("POST", "/channels", { name: `work-${tag}`, kind: "channel", memberHandles: [`sc-${tag}`] });
const chB = await api("POST", "/channels", { name: `general-${tag}`, kind: "channel", memberHandles: [`sc-${tag}`] });

const dbUrl = process.env.DATABASE_URL;
const runnerToken = execSync(
  `psql "${dbUrl}" -tAc "select runner_token from participants where id = '${agent.id}'"`,
).toString().trim();

// --- fake runner: on enqueue, start a turn and STAY working (no turn_done until we say so) ---
let turnId = null;
let sawEnqueue = false;
const runner = new WebSocket(`ws://localhost:${PORT}/api/runner?token=${runnerToken}`);
runner.on("open", () => runner.send(JSON.stringify({ type: "hello", agentId: "x", sessionId: "s1", protocol: 1 })));
runner.on("message", (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.type === "configure") runner.send(JSON.stringify({ type: "state", state: "idle", sessionId: "s1" }));
  if (f.type === "enqueue") {
    sawEnqueue = true;
    const inboxIds = (f.items || []).map((i) => i.inboxId);
    turnId = `sc-turn-${tag}`;
    runner.send(JSON.stringify({ type: "turn_started", turnId, inboxIds }));
    runner.send(JSON.stringify({ type: "consumed", inboxIds, turnId }));
    runner.send(JSON.stringify({ type: "state", state: "running", sessionId: "s1" }));
    runner.send(JSON.stringify({
      type: "event",
      turnId,
      event: { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } },
    }));
  }
});
await new Promise((r) => runner.on("open", r));
await new Promise((r) => setTimeout(r, 800)); // configure round-trip

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 850 } });
const pageErrors = [];
page.on("pageerror", (e) => { pageErrors.push(e.message); console.log("PAGEERROR:", e.message); });

try {
  await page.goto(`${URL}/?as=${HUMAN}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // Open channel A and send a message mentioning the agent.
  await page.locator(`[data-testid="channel-item"]`, { hasText: `work-${tag}` }).click();
  await page.waitForTimeout(600);
  const composer = page.locator('[data-testid="composer-input"]');
  await composer.click();
  await composer.type(`@sc-${tag} `);
  await page.waitForTimeout(400);
  // Accept the mention if the popup is open, then finish the line and send.
  if (await page.locator('[data-testid="mention-option"]').count()) {
    await page.locator('[data-testid="mention-option"]').first().click();
  }
  await composer.type("please run the tests");
  await page.keyboard.press("Enter");

  // The dispatch reaches the fake runner, which starts a (non-finishing) turn.
  await page.waitForTimeout(2500);
  check("fake runner received the dispatch", sawEnqueue);

  // Trigger-message chip appears under the asking message, in RUNNING state.
  const chip = page.locator('[data-testid="turn-chip"]');
  await page.waitForTimeout(1500);
  check("trigger-message chip renders", (await chip.count()) > 0);
  check("chip is in running state", (await page.locator('[data-testid="turn-chip"][data-state="running"]').count()) > 0);
  // The DM-only activity strip must NOT be present in a channel.
  check("no activity strip in channel", (await page.locator('[data-testid="channel-activity"]').count()) === 0);
  await shot(page, "chip-running");

  // Sidebar working-dot on channel A, and NOT on channel B (agent idle there).
  const dotA = page.locator(`[data-testid="channel-item"]`, { hasText: `work-${tag}` }).locator('[data-testid="channel-working-dot"]');
  const dotB = page.locator(`[data-testid="channel-item"]`, { hasText: `general-${tag}` }).locator('[data-testid="channel-working-dot"]');
  check("sidebar working-dot on the active channel", (await dotA.count()) > 0);
  check("no working-dot on the idle channel (scoping holds)", (await dotB.count()) === 0);

  // Header roster button shows the active dot; open it and see the agent working.
  check("header roster active-dot", (await page.locator('[data-testid="roster-active-dot"]').count()) > 0);
  await page.locator('[data-testid="roster-button"]').click();
  await page.waitForTimeout(500);
  check("roster panel lists the agent", (await page.getByText(`Scope Agent ${tag}`).count()) > 0);
  await shot(page, "roster");

  // Hover the agent mention -> hover card.
  await page.locator('[data-testid="mention-badge"]').first().hover();
  await page.waitForTimeout(500);
  check("agent hover card appears", (await page.locator('[data-testid="agent-hover-card"]').count()) > 0);
  await shot(page, "hovercard");

  // Switch to channel B: no chip there (scoping).
  await page.locator(`[data-testid="channel-item"]`, { hasText: `general-${tag}` }).click();
  await page.waitForTimeout(600);
  check("no chip in the unrelated channel", (await page.locator('[data-testid="turn-chip"]').count()) === 0);

  // Finish the turn -> chip settles to done back in channel A.
  runner.send(JSON.stringify({ type: "event", turnId, event: { type: "result", subtype: "success", duration_ms: 4200 } }));
  runner.send(JSON.stringify({ type: "turn_done", turnId, ok: true }));
  runner.send(JSON.stringify({ type: "state", state: "idle", sessionId: "s1" }));
  await page.locator(`[data-testid="channel-item"]`, { hasText: `work-${tag}` }).click();
  await page.waitForTimeout(1500);
  check("chip settles to done", (await page.locator('[data-testid="turn-chip"][data-state="done"]').count()) > 0);
  await shot(page, "chip-done");

  check("no uncaught page errors", pageErrors.length === 0);
} catch (e) {
  console.log("FATAL:", e.message);
  await shot(page, "fatal");
  fail++;
} finally {
  runner.close();
  await browser.close();
}
console.log(`\nACTIVITY SCOPING UI: ${fail} failures`);
process.exit(fail ? 1 : 0);
