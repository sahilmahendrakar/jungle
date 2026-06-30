// Verify the sidebar nav: switch-user (#2), DM creation by clicking a person (#3),
// and add-agent from within the app (#1). Self-cleaning. Exit 0 = PASS.
import { chromium } from "playwright";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:3001";
const APP = "http://localhost:5173";
const sfx = Date.now().toString(36);
const me = `me_${sfx}`;
const buddy = `buddy_${sfx}`;
const agent = `bot-${sfx}`;
const SHOT = "/tmp/shots/sidebar.png";
const post = (p, b) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic();
mkdirSync("/tmp/shots", { recursive: true });
let pass = false, browser;
let meId, buddyId;

try {
  meId = (await post("/api/participants", { kind: "human", handle: me, displayName: "Me" })).id;
  buddyId = (await post("/api/participants", { kind: "human", handle: buddy, displayName: "Buddy" })).id;

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // signed in
  await page.goto(`${APP}/?as=${meId}`, { waitUntil: "networkidle" });
  await page.getByTestId("composer-input").waitFor({ timeout: 15000 });

  // (#2) switch user -> back to sign-in
  await page.getByTestId("switch-user").click();
  await page.getByTestId("signin").waitFor({ timeout: 10000 });
  const switched = await page.getByTestId("signin").isVisible();

  // back in
  await page.goto(`${APP}/?as=${meId}`, { waitUntil: "networkidle" });
  await page.getByTestId("people-item").filter({ hasText: `@${buddy}` }).first().waitFor({ timeout: 15000 });

  // (#3) click a person -> DM created + selected; send a message
  await page.getByTestId("people-item").filter({ hasText: `@${buddy}` }).first().click();
  await page.getByTestId("channel-item").filter({ hasText: `@${buddy}` }).waitFor({ timeout: 15000 });
  const dmCreated = (await page.getByTestId("channel-item").filter({ hasText: `@${buddy}` }).count()) > 0;
  await page.getByTestId("composer-input").fill(`hello ${buddy}`);
  await page.getByTestId("send-button").click();
  await page.getByTestId("message").filter({ hasText: `hello ${buddy}` }).waitFor({ timeout: 15000 });
  const dmMsg = (await page.getByTestId("message").filter({ hasText: `hello ${buddy}` }).count()) > 0;

  // (#1) add an agent from within the app -> appears in People
  await page.getByTestId("add-agent-toggle").click();
  await page.getByTestId("agent-handle").fill(agent);
  await page.getByTestId("agent-name").fill("Bot");
  await page.getByTestId("add-agent-button").click();
  await page.getByTestId("people-item").filter({ hasText: `@${agent}` }).waitFor({ timeout: 30000 });
  const agentAdded = (await page.getByTestId("people-item").filter({ hasText: `@${agent}` }).count()) > 0;

  await page.screenshot({ path: SHOT, fullPage: true });

  const checks = {
    "switch-user returns to sign-in": switched,
    "DM created by clicking a person": dmCreated,
    "message sent in DM renders": dmMsg,
    "agent added from within the app": agentAdded,
    "no page errors": errors.length === 0,
  };
  console.log("checks:", checks);
  if (errors.length) console.log("page errors:", errors);
  pass = Object.values(checks).every(Boolean);
} catch (e) {
  console.error("ERROR:", e.message);
} finally {
  try { await browser?.close(); } catch {}
  const ag = (await pool.query("select id, ma_session_id from participants where handle=$1", [agent]).catch(() => ({ rows: [] }))).rows[0];
  // delete DM channels involving me, then participants
  await pool.query(
    `delete from channels where kind='dm' and id in (select channel_id from channel_members where participant_id = any($1))`,
    [[meId, buddyId]],
  ).catch(() => {});
  await pool.query("delete from participants where handle = any($1)", [[me, buddy, agent]]).catch(() => {});
  await pool.end();
  if (ag?.ma_session_id) await anthropic.beta.sessions.delete(ag.ma_session_id).catch(() => {});
}

console.log(pass ? "✅ SIDEBAR-UI PASS" : "❌ SIDEBAR-UI FAIL");
process.exit(pass ? 0 : 1);
