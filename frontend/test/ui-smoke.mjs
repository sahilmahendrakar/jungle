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
    const composer = page.locator('[data-testid="composer-input"]');
    check("composer input present", (await composer.count()) > 0);
    // Exercise the extracted composer's draft + mention state without posting: typing "@" opens
    // the mention autocomplete. Clear it afterward so nothing is left staged.
    await composer.first().click();
    await composer.first().type("@");
    check("composer mention popup opens", await page.locator('[data-testid="mention-popup"]').first().isVisible({ timeout: 2000 }).catch(() => false));
    await page.keyboard.press("Escape");
    await composer.first().fill("");
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

  // New-channel dialog: name field + member options render, then CLOSE without creating.
  await page.locator('[data-testid="new-channel-toggle"]').first().click();
  await page.waitForTimeout(500);
  check("new-channel dialog: name field", (await page.locator('[data-testid="new-channel-name"]').count()) > 0);
  check("new-channel dialog: member options", (await page.locator('[data-testid="member-option"]').count()) > 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // Members dialog: open a non-DM channel, open its members panel, verify the add-input + roster.
  if (nChannels > 0) {
    await channels.first().click();
    await page.waitForTimeout(500);
    const membersBtn = page.locator('[data-testid="members-button"]').first();
    if (await membersBtn.count()) {
      await membersBtn.click();
      await page.locator('[data-testid="member-row"]').first().waitFor({ timeout: 4000 }).catch(() => {});
      check("members dialog: add input", (await page.locator('[data-testid="member-add-input"]').count()) > 0);
      check("members dialog: roster rows", (await page.locator('[data-testid="member-row"]').count()) > 0);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
  }

  // Threads panel: open the Threads nav -> right panel renders in list mode, then close it.
  await page.locator('[data-testid="threads-nav"]').first().click();
  await page.waitForTimeout(600);
  check("threads panel opens", (await page.locator('[data-testid="right-panel"]').count()) > 0);
  const threadClose = page.locator('[data-testid="thread-close"]').first();
  if (await threadClose.count()) {
    await threadClose.click();
    await page.waitForTimeout(300);
  }

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

  // Agent flow: open a DM with an existing agent (row with a status dot), open its profile from
  // the DM header, then open the Activity view. Covers the SDK mode/model selects + transcript.
  const agentRow = page.locator('[data-testid="people-item"]:has([data-testid="status-dot"])').first();
  if (await agentRow.count()) {
    await agentRow.click();
    await page.waitForTimeout(700);
    const dmProfile = page.locator('[data-testid="dm-header-profile"]').first();
    if (await dmProfile.count()) {
      await dmProfile.click();
      await page.waitForTimeout(700);
      check("agent profile: SDK mode select", (await page.locator('[data-testid="agent-mode-select"]').count()) > 0);
      check("agent profile: model select", (await page.locator('[data-testid="agent-model-select"]').count()) > 0);
      const activityBtn = page.locator('[data-testid="activity-open"]').first();
      check("agent profile: Activity button", (await activityBtn.count()) > 0);
      if (await activityBtn.count()) {
        await activityBtn.click();
        await page.waitForTimeout(900);
        check("activity transcript opens", (await page.locator('[data-testid="activity-transcript"]').count()) > 0);
        check("activity steering input present", (await page.locator('[data-testid="activity-steer-input"]').count()) > 0);
        await shot(page, "activity");
      }
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
