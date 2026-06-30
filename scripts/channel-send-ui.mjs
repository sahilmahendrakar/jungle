// Verify channel creation + sending from the UI (the "no channels, can't send" fix).
//  1) signed in with no channels, clicking Send shows a notice (not a silent no-op)
//  2) create a channel (name + a member) from the sidebar -> it appears and is selected
//  3) send a message -> it round-trips over WS and renders
// Self-cleaning. Needs backend (:3001) + frontend (:5173). Exit 0 = PASS.
import { chromium } from "playwright";
import pg from "pg";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:3001";
const APP = "http://localhost:5173";
const sfx = Date.now().toString(36);
const me = `me_${sfx}`;
const buddy = `buddy_${sfx}`;
const chanName = `room_${sfx}`;
const SHOT = "/tmp/shots/channel-send.png";
const post = (p, b) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
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
  await page.goto(`${APP}/?as=${meId}`, { waitUntil: "networkidle" });
  await page.getByTestId("composer-input").waitFor({ timeout: 15000 });

  // (1) send with no channel -> notice, not silent
  await page.getByTestId("composer-input").fill("ping");
  await page.getByTestId("send-button").click();
  await page.getByTestId("send-notice").waitFor({ timeout: 5000 });
  const noticeShown = (await page.getByTestId("send-notice").innerText()).toLowerCase().includes("channel");

  // (2) create a channel including buddy
  await page.getByTestId("new-channel-toggle").click();
  await page.getByTestId("new-channel-name").fill(chanName);
  await page.getByTestId("member-option").filter({ hasText: `@${buddy}` }).locator("input[type=checkbox]").check();
  await page.getByTestId("create-channel-button").click();
  await page.getByTestId("channel-item").filter({ hasText: chanName }).waitFor({ timeout: 15000 });
  const channelCreated = (await page.getByTestId("channel-item").filter({ hasText: chanName }).count()) > 0;

  // (3) send a message -> renders
  const body = `hello ${chanName}`;
  await page.getByTestId("composer-input").fill(body);
  await page.getByTestId("send-button").click();
  await page.getByTestId("message").filter({ hasText: body }).waitFor({ timeout: 15000 });
  const sentRendered = (await page.getByTestId("message").filter({ hasText: body }).count()) > 0;
  const senderOk = (await page.getByTestId("message-sender").filter({ hasText: `@${me}` }).count()) > 0;

  await page.screenshot({ path: SHOT, fullPage: true });

  const checks = {
    "no-channel send shows a notice": noticeShown,
    "channel created from UI": channelCreated,
    "message sent and rendered": sentRendered,
    "message attributed to sender": senderOk,
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
  await pool.query("delete from channels where name = $1", [chanName]).catch(() => {});
  for (const id of [meId, buddyId]) if (id) await pool.query("delete from participants where id = $1", [id]).catch(() => {});
  await pool.end();
}

console.log(pass ? "✅ CHANNEL+SEND UI PASS" : "❌ CHANNEL+SEND UI FAIL");
process.exit(pass ? 0 : 1);
