// Playwright smoke of the SDK-agent UI against a dev-bypass backend (?as=<humanId>).
// Usage: node test/ui-sdk.mjs <frontendUrl> <humanParticipantId>
import { chromium } from "playwright";

const URL = process.argv[2];
const HUMAN = process.argv[3];
const shot = (p, name) => p.screenshot({ path: `/tmp/ui-${name}.png` });
const log = (...a) => console.log(...a);
let fail = 0;
const check = (n, ok) => { log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) fail++; };

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => log("PAGEERROR:", e.message));

const handle = `uitest-${Date.now().toString(36).slice(-4)}`;
try {
  await page.goto(`${URL}/?as=${HUMAN}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  check("app loaded (sidebar visible)", await page.locator("aside").first().isVisible());

  // --- create-agent dialog ---
  await page.locator('[data-testid="add-agent-toggle"]').first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="agent-handle"]').fill(handle);
  await page.locator('[data-testid="agent-name"]').fill("UI Test Agent");
  check("create dialog has mode select", (await page.locator('[data-testid="agent-mode"]').count()) > 0);
  check("create dialog has model select", (await page.locator('[data-testid="agent-model"]').count()) > 0);
  check("default mode is 'Ask on sensitive'",
    /ask/i.test(await page.locator('[data-testid="agent-mode"]').innerText()));
  await shot(page, "create-dialog");
  await page.locator('[data-testid="add-agent-button"]').click();
  await page.waitForTimeout(2500);
  // New agents render display name as text; @handle lives in the row's title attribute.
  const peopleRow = page.locator(`[data-testid="people-item"][title="@${handle}"]`).first();
  check("new agent appears in People", (await peopleRow.count()) > 0);
  await shot(page, "after-create");

  // --- open a DM with the agent, then open its profile from the DM header ---
  await peopleRow.click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="dm-header-profile"]').first().click();
  await page.waitForTimeout(700);

  check("profile shows SDK mode select", (await page.locator('[data-testid="agent-mode-select"]').count()) > 0);
  check("profile shows editable model select", (await page.locator('[data-testid="agent-model-select"]').count()) > 0);
  check("profile shows Activity button", (await page.locator('[data-testid="activity-open"]').count()) > 0);
  await shot(page, "profile");

  // --- Activity view ---
  if (await page.locator('[data-testid="activity-open"]').count()) {
    await page.locator('[data-testid="activity-open"]').first().click();
    await page.waitForTimeout(800);
    check("activity transcript opens", (await page.locator('[data-testid="activity-transcript"]').count()) > 0);
    check("activity steering input present", (await page.locator('[data-testid="activity-steer-input"]').count()) > 0);
    await shot(page, "activity");
  }
  log(`\nUI DONE: ${fail} failures (handle=@${handle})`);
} catch (e) {
  log("FATAL:", e.message);
  await shot(page, "fatal");
  fail++;
} finally {
  await browser.close();
  console.log(`__HANDLE__ ${handle}`);
  process.exit(fail ? 1 : 0);
}
