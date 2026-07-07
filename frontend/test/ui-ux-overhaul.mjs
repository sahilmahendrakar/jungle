// UI e2e for the UX-overhaul surfaces, against a dev-bypass backend seeded by
// backend/test/ux-features.mjs (a DM with an agent reply that carries a PR deliverable):
// sidebar navs, agents home, deliverables feed (+ jump to message), approvals empty state,
// ⌘K search (server FTS hit -> jump), inline deliverable chips, view-work hover action.
// Usage: node test/ui-ux-overhaul.mjs <frontendUrl> <humanParticipantId>
import { chromium } from "playwright";

const URL = process.argv[2];
const HUMAN = process.argv[3];
const log = (...a) => console.log(...a);
let fail = 0;
const check = (n, ok) => { log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) fail++; };
const shot = (p, name) => p.screenshot({ path: `/tmp/uxtest-${name}.png`, fullPage: false }).catch(() => {});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 850 } });
const pageErrors = [];
page.on("pageerror", (e) => { pageErrors.push(e.message); log("PAGEERROR:", e.message); });

try {
  await page.goto(`${URL}/?as=${HUMAN}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  // --- Sidebar navs ---
  for (const nav of ["search-nav", "agents-nav", "approvals-nav", "deliverables-nav"]) {
    check(`sidebar: ${nav} visible`, await page.locator(`[data-testid="${nav}"]`).isVisible());
  }

  // --- Agents home ---
  await page.locator('[data-testid="agents-nav"]').click();
  await page.waitForTimeout(600);
  check("agents home renders", await page.locator('[data-testid="agents-home"]').isVisible());
  const cards = await page.locator('[data-testid="agent-card"]').count();
  check("agent cards render", cards > 0);
  check(
    "agent card shows a status pill",
    (await page.locator('[data-testid="agent-card-status"]').count()) > 0,
  );
  await shot(page, "agents-home");

  // --- Deliverables feed ---
  await page.locator('[data-testid="deliverables-nav"]').click();
  await page.waitForTimeout(600);
  check("deliverables view renders", await page.locator('[data-testid="deliverables-view"]').isVisible());
  const row = page.locator('[data-testid="deliverable-row"]').first();
  check("deliverable row present", await row.isVisible());
  check(
    "deliverable row carries the PR title",
    (await page.locator('[data-testid="deliverable-row"]', { hasText: "Fix the login flow" }).count()) > 0,
  );
  await shot(page, "deliverables");

  // Jump to the conversation behind the deliverable.
  await row.hover();
  await page.locator('[data-testid="deliverable-jump"]').first().click();
  await page.waitForTimeout(900);
  check(
    "deliverable jump lands in the conversation",
    (await page.locator('[data-testid="message-list"]').count()) > 0,
  );
  check(
    "inline deliverable chip renders under the agent message",
    (await page.locator('[data-testid="deliverable-chip"]').count()) > 0,
  );
  await shot(page, "dm-with-chip");

  // --- View-work hover action on the agent's message ---
  const agentMsg = page.locator('[data-testid="message"]', { hasText: "Fix the login flow" }).first();
  await agentMsg.hover();
  await page.waitForTimeout(200);
  check("view-work hover action present", (await page.locator('[data-testid="view-work"]').count()) > 0);
  await page.locator('[data-testid="view-work"]').first().click();
  await page.waitForTimeout(900);
  // Activity now opens in the RIGHT PANEL (not a modal).
  check("activity opens in the sidebar from view-work", await page.locator('[data-testid="activity-panel-identity"]').isVisible());
  const turnCount = await page.locator('[data-testid="activity-turn"]').count();
  check("activity shows the producing turn", turnCount > 0);
  check("activity panel has a steer box", (await page.locator('[data-testid="activity-panel-steer"]').count()) > 0);
  await shot(page, "view-work");
  await page.locator('[data-testid="activity-panel-close"]').click();
  await page.waitForTimeout(400);

  // --- Approvals (empty after the backend test resolved its confirm) ---
  await page.locator('[data-testid="approvals-nav"]').click();
  await page.waitForTimeout(600);
  check("approvals view renders", await page.locator('[data-testid="approvals-view"]').isVisible());
  check(
    "approvals shows the empty state",
    (await page.getByText("Nothing waiting on you").count()) > 0,
  );

  // --- ⌘K search ---
  await page.keyboard.press("ControlOrMeta+k");
  await page.waitForTimeout(400);
  check("search dialog opens on ⌘K", await page.locator('[data-testid="search-dialog"]').isVisible());
  await page.locator('[data-testid="search-input"]').fill("login flow review");
  await page.waitForTimeout(900);
  const hits = await page.locator('[data-testid="search-result-message"]').count();
  check("search finds the message via FTS", hits > 0);
  await shot(page, "search");
  if (hits > 0) {
    await page.locator('[data-testid="search-result-message"]').first().click();
    await page.waitForTimeout(900);
    check(
      "search hit jumps into the conversation",
      (await page.locator('[data-testid="message-list"]').count()) > 0,
    );
  }

  check("no uncaught page errors", pageErrors.length === 0);
} catch (e) {
  log("FATAL:", e.message);
  await shot(page, "fatal");
  fail++;
} finally {
  await browser.close();
}
log(`\nUX OVERHAUL UI: ${fail} failures`);
process.exit(fail ? 1 : 0);
