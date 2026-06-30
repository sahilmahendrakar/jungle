// Verify the "@agent is working…" indicator shows during an agent turn and clears after.
// Seeds human + agent + channel, opens the app as the human, @mentions the agent, asserts
// the working-indicator appears, then the agent's reply renders. Self-cleaning. Exit 0 = PASS.
import { chromium } from "playwright";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:3001";
const APP = "http://localhost:5173";
const sfx = Date.now().toString(36);
const human = `wi_${sfx}`;
const ag = `worker-${sfx}`;
const chan = `wichan_${sfx}`;
const SHOT = "/tmp/shots/working-indicator.png";
const post = (p, b) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic();
mkdirSync("/tmp/shots", { recursive: true });
let pass = false, browser;
let humanId, agentId, channelId, maSessionId;

try {
  humanId = (await post("/api/participants", { kind: "human", handle: human, displayName: "WI" })).id;
  const agent = await post("/api/agents", { handle: ag, displayName: "Worker" });
  agentId = agent.id; maSessionId = agent.ma_session_id;
  channelId = (await post("/api/channels", { name: chan, kind: "channel", memberHandles: [human, ag] })).id;

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${APP}/?as=${humanId}`, { waitUntil: "networkidle" });
  await page.getByTestId("channel-item").filter({ hasText: chan }).waitFor({ timeout: 15000 });

  await page.getByTestId("composer-input").fill(`@${ag} say hi briefly`);
  await page.getByTestId("send-button").click();

  // indicator appears during the turn
  await page.getByTestId("working-indicator").waitFor({ state: "visible", timeout: 20000 });
  const indicatorText = await page.getByTestId("working-indicator").innerText();
  await page.screenshot({ path: SHOT, fullPage: true });

  // agent reply lands
  await page.getByTestId("message-sender").filter({ hasText: `@${ag}` }).first().waitFor({ timeout: 90000 });
  // indicator clears afterwards
  await page.getByTestId("working-indicator").waitFor({ state: "hidden", timeout: 15000 });

  const checks = {
    "working indicator appeared": indicatorText.toLowerCase().includes("working"),
    "indicator names the agent": indicatorText.includes(`@${ag}`),
    "agent reply rendered": (await page.getByTestId("message-sender").filter({ hasText: `@${ag}` }).count()) > 0,
    "indicator cleared after reply": (await page.getByTestId("working-indicator").count()) === 0,
    "no page errors": errors.length === 0,
  };
  console.log("checks:", checks);
  if (errors.length) console.log("page errors:", errors);
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

console.log(pass ? "✅ WORKING-INDICATOR PASS" : "❌ WORKING-INDICATOR FAIL");
process.exit(pass ? 0 : 1);
