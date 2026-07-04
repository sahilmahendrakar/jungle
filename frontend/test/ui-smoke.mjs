// Lightweight no-agent UI smoke: verifies the app renders and core interactions work, without
// creating agents (so it's safe to run repeatedly against a dev-bypass backend). Exercises the
// render trees most affected by component extraction: sidebar, channel view + composer, the
// create-agent dialog, and a profile dialog.
// Usage: node test/ui-smoke.mjs <frontendUrl> <humanParticipantId>
import { chromium } from "playwright";

const URL = process.argv[2];
const HUMAN = process.argv[3];
const shot = (p, name) => p.screenshot({ path: `/tmp/uismoke-${name}.png` }).catch(() => {});
const log = (...a) => console.log(...a);
let fail = 0;
const check = (n, ok) => { log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) fail++; };

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => { pageErrors.push(e.message); log("PAGEERROR:", e.message); });

try {
  await page.goto(`${URL}/?as=${HUMAN}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  check("app loaded (sidebar visible)", await page.locator('[data-testid="sidebar"]').first().isVisible());

  const channels = page.locator('[data-testid="channel-item"]');
  const nChannels = await channels.count();
  check("channels render in sidebar", nChannels > 0);
  check("people render in sidebar", (await page.locator('[data-testid="people-item"]').count()) > 0);

  // Open the first channel -> message list + composer.
  if (nChannels > 0) {
    await channels.first().click();
    await page.waitForTimeout(800);
    check("message list renders", (await page.locator('[data-testid="message-list"]').count()) > 0);
    check("composer input present", (await page.locator('[data-testid="composer-input"]').count()) > 0);
    await shot(page, "channel");
  }

  // Create-agent dialog: fields present, then CLOSE without creating.
  await page.locator('[data-testid="add-agent-toggle"]').first().click();
  await page.waitForTimeout(500);
  check("create-agent dialog: handle field", (await page.locator('[data-testid="agent-handle"]').count()) > 0);
  check("create-agent dialog: mode select", (await page.locator('[data-testid="agent-mode"]').count()) > 0);
  check("create-agent dialog: model select", (await page.locator('[data-testid="agent-model"]').count()) > 0);
  await shot(page, "create-dialog");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // Profile dialog via People -> DM -> profile (existing participant; no agent created).
  const person = page.locator('[data-testid="people-item"]').first();
  if (await person.count()) {
    await person.click();
    await page.waitForTimeout(700);
    const profBtn = page.locator('[data-testid="dm-header-profile"]').first();
    if (await profBtn.count()) {
      await profBtn.click();
      await page.waitForTimeout(700);
      check("profile panel opens", (await page.locator('[data-testid="profile-panel"]').count()) > 0);
      await shot(page, "profile");
      const close = page.locator('[data-testid="profile-close"]').first();
      if (await close.count()) await close.click();
    }
  }

  check("no uncaught page errors", pageErrors.length === 0);
  log(`\nSMOKE DONE: ${fail} failures`);
} catch (e) {
  log("FATAL:", e.message);
  await shot(page, "fatal");
  fail++;
} finally {
  await browser.close();
  process.exit(fail ? 1 : 0);
}
