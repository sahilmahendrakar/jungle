// Step 5 verification: drive the real React UI headlessly with Playwright.
// Seeds a human + agent + channel, loads the app as the human, sends an @mention,
// asserts the sent message round-trips into the DOM and the agent's reply renders,
// and saves a screenshot. Self-cleaning. Exit 0 = PASS.
//
// Needs backend (:3001) + frontend dev (:5173) running.
// Run: set -a; . .env; set +a; node scripts/step5-ui.mjs
import { chromium } from "playwright";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:3001";
const APP = "http://localhost:5173";
const sfx = Date.now().toString(36);
const human = `ui_${sfx}`;
const agentHandle = `uibot_${sfx}`;
const chanName = `uichan_${sfx}`;
const SHOT = "/tmp/shots/step5.png";

const post = (p, b) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic();
mkdirSync("/tmp/shots", { recursive: true });
let pass = false;
let channelId, humanId, agentId, maSessionId, browser;

try {
  humanId = (await post("/api/participants", { kind: "human", handle: human, displayName: "UI Tester" })).id;
  const agent = await post("/api/agents", { handle: agentHandle, displayName: "UI Bot" });
  agentId = agent.id;
  maSessionId = agent.ma_session_id;
  channelId = (await post("/api/channels", { name: chanName, kind: "channel", memberHandles: [human, agentHandle] })).id;
  console.log("setup:", { humanId, agentId, channelId });

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${APP}/?as=${humanId}`, { waitUntil: "networkidle" });

  // channel rendered in sidebar
  await page.getByTestId("channel-item").filter({ hasText: chanName }).waitFor({ timeout: 15000 });

  // type an @mention and send
  const msg = `@${agentHandle} say hi in a few words`;
  await page.getByTestId("composer-input").fill(msg);
  await page.getByTestId("send-button").click();

  // sent message round-trips into the DOM (proves send -> persist -> fan-out -> render)
  await page.getByTestId("message").filter({ hasText: msg }).waitFor({ timeout: 15000 });

  // agent reply renders (a message whose SENDER is the agent)
  await page.getByTestId("message-sender").filter({ hasText: `@${agentHandle}` }).first().waitFor({ timeout: 90000 });

  await page.screenshot({ path: SHOT, fullPage: true });

  const sentCount = await page.getByTestId("message").filter({ hasText: msg }).count();
  const agentSenderCount = await page.getByTestId("message-sender").filter({ hasText: `@${agentHandle}` }).count();
  const msgCount = await page.getByTestId("message").count();

  const checks = {
    "sent message round-tripped into UI": sentCount > 0,
    "agent reply rendered in UI": agentSenderCount > 0,
    "at least 2 messages on screen": msgCount >= 2,
    "no page errors": errors.length === 0,
  };
  console.log("checks:", checks);
  if (errors.length) console.log("page errors:", errors);
  console.log("screenshot:", SHOT);
  pass = Object.values(checks).every(Boolean);
} catch (e) {
  console.error("ERROR:", e.message);
} finally {
  try { await browser?.close(); } catch {}
  if (channelId) await pool.query("delete from channels where id = $1", [channelId]).catch(() => {});
  for (const id of [humanId, agentId]) if (id) await pool.query("delete from participants where id = $1", [id]).catch(() => {});
  await pool.end();
  if (maSessionId) await anthropic.beta.sessions.delete(maSessionId).catch(() => {});
}

console.log(pass ? "✅ STEP 5 PASS" : "❌ STEP 5 FAIL");
process.exit(pass ? 0 : 1);
