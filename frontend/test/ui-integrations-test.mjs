// Focused Playwright test of the redesigned integrations UI + the save-flow fix.
// Usage: node /tmp/ui-integrations-test.mjs <frontendUrl> <humanParticipantId>
import { chromium } from "playwright";

const URL = process.argv[2];
const HUMAN = process.argv[3];
let fail = 0;
const log = (...a) => console.log(...a);
const check = (n, ok) => { log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) fail++; };
const shot = (p, name) => p.screenshot({ path: `/tmp/ui-int-${name}.png` });

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => log("PAGEERROR:", e.message));

const handle = `inttest-${Date.now().toString(36).slice(-4)}`;
try {
  await page.goto(`${URL}/?as=${HUMAN}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // --- create-agent dialog: picker search + thin rows ---
  await page.locator('[data-testid="add-agent-toggle"]').first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="agent-handle"]').fill(handle);
  await page.locator('[data-testid="agent-name"]').fill("Int Test Agent");
  await page.locator('[data-testid="add-integration"]').click();
  await page.waitForTimeout(300);
  check("picker has search box", (await page.locator('[data-testid="integration-search"]').count()) > 0);
  const optionsAll = await page.locator('[data-testid^="integration-option-"]').count();
  await page.locator('[data-testid="integration-search"]').fill("linear");
  await page.waitForTimeout(200);
  const optionsFiltered = await page.locator('[data-testid^="integration-option-"]').count();
  check(`picker search filters (${optionsAll} -> ${optionsFiltered})`, optionsAll > 1 && optionsFiltered === 1);
  await shot(page, "picker-search");
  await page.locator('[data-testid="integration-search"]').fill("");
  await page.waitForTimeout(200);
  await page.locator('[data-testid="integration-option-github"]').click();
  await page.waitForTimeout(300);
  check("github row appears", (await page.locator('[data-testid="integration-row-github"]').count()) > 0);
  // Row auto-expands after add: repo field (manual input in dev mode) should be visible.
  check("new row auto-expanded (repo input visible)",
    (await page.locator('[data-testid="integration-row-github"] input[placeholder*="owner"]').count()) > 0);
  await shot(page, "dialog-row-expanded");

  // Submit with empty repo must be blocked by validation (notice, no create).
  await page.locator('[data-testid="add-agent-button"]').click();
  await page.waitForTimeout(700);
  const stillOpen = (await page.locator('[data-testid="agent-handle"]').count()) > 0;
  check("create blocked while repo empty (validation)", stillOpen);

  // Fill the repo, then open Advanced: an invalid author email must be blocked by validation.
  await page.locator('[data-testid="integration-row-github"] input[placeholder*="owner"]').fill("acme/widgets");
  await page.locator('[data-testid="github-advanced-toggle"]').click();
  await page.waitForTimeout(200);
  await page.locator('[data-testid="github-author-email"]').fill("not-an-email");
  await page.locator('[data-testid="add-agent-button"]').click();
  await page.waitForTimeout(700);
  check("create blocked on invalid author email", (await page.locator('[data-testid="agent-handle"]').count()) > 0);

  // Valid identity -> create for real.
  await page.locator('[data-testid="github-author-name"]').fill("Octo Cat");
  await page.locator('[data-testid="github-author-email"]').fill("12345+octo@users.noreply.github.com");
  await page.locator('[data-testid="add-agent-button"]').click();
  await page.waitForTimeout(2000);
  const peopleRow = page.locator(`[data-testid="people-item"][title="@${handle}"]`).first();
  check("agent created with integration", (await peopleRow.count()) > 0);

  // --- profile panel: row shows saved repo; save-flow round trip ---
  await peopleRow.click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="dm-header-profile"]').first().click();
  await page.waitForTimeout(900);
  const row = page.locator('[data-testid="integration-row-github"]');
  check("profile shows github row", (await row.count()) > 0);
  check("row summary shows repo", /acme\/widgets/.test(await row.innerText()));
  const saveBtn = page.locator('[data-testid="profile-save"]');
  check("save disabled when clean", await saveBtn.isDisabled());

  // Change the repo -> dirty -> save -> button returns to disabled + Saved appears.
  await page.locator('[data-testid="integration-toggle-github"]').click();
  await page.waitForTimeout(300);
  // Advanced auto-opens because an identity is set; it should show the saved values.
  check("author name persisted", (await row.locator('[data-testid="github-author-name"]').inputValue()) === "Octo Cat");
  check("author email persisted",
    (await row.locator('[data-testid="github-author-email"]').inputValue()) === "12345+octo@users.noreply.github.com");
  await row.locator('input[placeholder*="owner"]').fill("acme/other");
  await row.locator('[data-testid="github-author-name"]').fill("Octo Bot");
  await page.waitForTimeout(300);
  check("save enabled after edit", !(await saveBtn.isDisabled()));
  await saveBtn.click();
  await page.waitForTimeout(1500);
  check("Saved indicator shown", (await page.getByText("Saved", { exact: true }).count()) > 0);
  check("save disabled again after save (bug fix)", await saveBtn.isDisabled());
  check("author name round-tripped", (await row.locator('[data-testid="github-author-name"]').inputValue()) === "Octo Bot");
  await shot(page, "profile-after-save");

  // Remove the integration -> save -> disabled again, row gone.
  await page.locator('[data-testid="integration-row-github"]').hover();
  await page.locator('[data-testid="integration-remove-github"]').click();
  await page.waitForTimeout(300);
  check("save enabled after remove", !(await saveBtn.isDisabled()));
  await saveBtn.click();
  await page.waitForTimeout(1500);
  check("save disabled after removing+saving", await saveBtn.isDisabled());
  check("github row gone", (await page.locator('[data-testid="integration-row-github"]').count()) === 0);

  // Reload and confirm removal persisted server-side.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.locator(`[data-testid="people-item"][title="@${handle}"]`).first().click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="dm-header-profile"]').first().click();
  await page.waitForTimeout(900);
  check("removal persisted after reload", (await page.locator('[data-testid="integration-row-github"]').count()) === 0);
  await shot(page, "profile-final");

  log(`\nINTEGRATIONS UI DONE: ${fail} failures (handle=@${handle})`);
} catch (e) {
  log("FATAL:", e.message);
  await shot(page, "fatal");
  fail++;
} finally {
  await browser.close();
  process.exit(fail ? 1 : 0);
}
