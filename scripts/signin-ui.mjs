// Verify the dev sign-in screen with Playwright (headless).
//  1) screen renders when no ?as=; seeded participant is listed
//  2) clicking a participant signs in (sets ?as=) and shows their channel
//  3) choosing kind=agent reveals the repo field
//  4) create-a-human signs straight in (lands in the app)
// Self-cleaning. Needs backend (:3001) + frontend dev (:5173). Exit 0 = PASS.
// Run: set -a; . .env; set +a; node scripts/signin-ui.mjs   (env optional — backend has its own)
import { chromium } from "playwright";
import pg from "pg";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:3001";
const APP = "http://localhost:5173";
const sfx = Date.now().toString(36);
const human = `signin_${sfx}`;
const chanName = `siginchan_${sfx}`;
const SHOT = "/tmp/shots/signin.png";
const post = (p, b) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
mkdirSync("/tmp/shots", { recursive: true });
let pass = false, browser;
let humanId, channelId, createdId;

try {
  humanId = (await post("/api/participants", { kind: "human", handle: human, displayName: "Signin Tester" })).id;
  channelId = (await post("/api/channels", { name: chanName, kind: "channel", memberHandles: [human] })).id;
  console.log("seeded:", { humanId, channelId });

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // (1) sign-in screen + seeded participant listed
  await page.goto(APP, { waitUntil: "networkidle" });
  await page.getByTestId("signin").waitFor({ timeout: 15000 });
  const seededItem = page.getByTestId("participant-item").filter({ hasText: `@${human}` });
  await seededItem.first().waitFor({ timeout: 15000 });
  const listedOk = (await seededItem.count()) > 0;

  // open the (collapsed) create form + capture the sign-in screen itself
  await page.getByTestId("create-toggle").click();
  await page.screenshot({ path: "/tmp/shots/signin-screen.png", fullPage: true });

  // (3) kind=agent reveals repo field; back to human hides it (do before navigating away)
  await page.getByTestId("new-kind").selectOption("agent");
  await page.getByTestId("new-repo").waitFor({ state: "visible", timeout: 5000 });
  const repoShown = await page.getByTestId("new-repo").isVisible();
  await page.getByTestId("new-kind").selectOption("human");
  const repoHidden = !(await page.getByTestId("new-repo").isVisible().catch(() => false));

  // (4) create a human -> signs straight in (lands in app: composer present, signin gone)
  await page.getByTestId("new-handle").fill(`made_${sfx}`);
  await page.getByTestId("new-display-name").fill("Made In UI");
  await page.getByTestId("create-button").click();
  await page.getByTestId("composer-input").waitFor({ timeout: 15000 });
  const createdSignedIn = page.url().includes("?as=") && !(await page.getByTestId("signin").isVisible().catch(() => false));
  createdId = new URL(page.url()).searchParams.get("as");

  // (2) click an existing participant -> signs in + their channel shows
  await page.goto(APP, { waitUntil: "networkidle" });
  await page.getByTestId("participant-item").filter({ hasText: `@${human}` }).first().click();
  await page.getByTestId("channel-item").filter({ hasText: chanName }).waitFor({ timeout: 15000 });
  const clickSignedIn = page.url().includes(`as=${humanId}`);
  const channelShown = (await page.getByTestId("channel-item").filter({ hasText: chanName }).count()) > 0;

  await page.screenshot({ path: SHOT, fullPage: true });

  const checks = {
    "sign-in screen renders": true,
    "seeded participant listed": listedOk,
    "kind=agent reveals repo field": repoShown,
    "kind=human hides repo field": repoHidden,
    "create-human signs straight in": createdSignedIn,
    "click existing participant signs in": clickSignedIn,
    "signed-in participant's channel shown": channelShown,
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
  for (const id of [humanId, createdId]) if (id) await pool.query("delete from participants where id = $1", [id]).catch(() => {});
  await pool.end();
}

console.log(pass ? "✅ SIGN-IN UI PASS" : "❌ SIGN-IN UI FAIL");
process.exit(pass ? 0 : 1);
