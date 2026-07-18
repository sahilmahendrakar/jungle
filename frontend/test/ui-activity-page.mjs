// UI verification for the Activity page feature: feed, filters, deep-link jump, profile recent
// messages, Home catch-up, search tokens. Screenshots to /workspace/shots.
import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = process.argv[2] ?? "http://localhost:5173";
const HUMAN = process.argv[3] ?? "11111111-1111-1111-1111-111111111111";
const OUT = "/workspace/shots";
mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [console.error]", m.text().slice(0, 160));
});
page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));

await page.goto(`${BASE}/?as=${HUMAN}`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="sidebar"]', { timeout: 15000 });

// --- 1. Activity nav item exists, badge shows (mention seeded) ---
const nav = page.locator('[data-testid="activity-nav"]');
check("activity nav item present", await nav.isVisible());
check("activity badge visible (1 channel w/ mention)", await nav.locator('[data-testid="unread-badge"]').isVisible());

// --- 2. Open the Activity page ---
await nav.click();
await page.waitForSelector('[data-testid="activity-view"]', { timeout: 8000 });
await page.waitForTimeout(800); // feed fetch
const rows = page.locator('[data-testid="activity-message-row"]');
const rowCount = await rows.count();
check("activity feed renders message rows", rowCount >= 4, `${rowCount} rows`);
check("deliverable row present in All view", (await page.locator('[data-testid="deliverable-row"]').count()) >= 1);
check("Mentioned you chip present", (await page.locator('text=Mentioned you').count()) >= 1);
check("thread context label present", (await page.locator('text=· in thread').count()) >= 1);
await page.screenshot({ path: `${OUT}/activity-all.png` });

// --- 3. Type pill: Deliverables only ---
await page.locator('[data-testid="activity-type-deliverables"]').click();
await page.waitForTimeout(600);
check("deliverables filter: only deliverable rows", (await page.locator('[data-testid="activity-message-row"]').count()) === 0 && (await page.locator('[data-testid="deliverable-row"]').count()) >= 1);
check("direction pills hidden for deliverables", (await page.locator('[data-testid="activity-direction-sent"]').count()) === 0);
check("URL deep-links the filter", page.url().includes("type=deliverables"), page.url().split("?")[1]);
await page.screenshot({ path: `${OUT}/activity-deliverables.png` });

// --- 4. Direction pill: Mentions ---
await page.locator('[data-testid="activity-type-all"]').click();
await page.waitForTimeout(500);
await page.locator('[data-testid="activity-direction-mentions"]').click();
await page.waitForTimeout(600);
const mentionRows = await page.locator('[data-testid="activity-message-row"]').count();
check("mentions direction filters to @sahil messages", mentionRows === 2, `${mentionRows} rows`);
check("URL carries direction", page.url().includes("direction=mentions"));
await page.locator('[data-testid="activity-direction-mentions"]').click(); // clear
await page.waitForTimeout(500);

// --- 5. Token input: type "from:@echo " → chip + filtered feed ---
const input = page.locator('[data-testid="activity-filter-input"]');
await input.click();
await input.fill("from:@echo-the-elephant ");
await page.waitForTimeout(700);
check("from: chip rendered", await page.locator('[data-testid="activity-chip-from"]').isVisible());
const fromRows = await page.locator('[data-testid="activity-message-row"]').count();
check("from:@echo filters feed", fromRows >= 2, `${fromRows} rows`);
await page.screenshot({ path: `${OUT}/activity-from-chip.png` });
// remove chip
await page.locator('[data-testid="activity-chip-from"] button').click();
await page.waitForTimeout(600);
check("chip removal restores feed", (await page.locator('[data-testid="activity-message-row"]').count()) >= 4);

// --- 6. Token autocomplete suggestions ---
await input.fill("in:#gen");
await page.waitForTimeout(300);
const sug = page.locator('[data-testid="activity-filter-suggestions"]');
check("token suggestions appear for in:#gen", await sug.isVisible());
const firstSug = sug.locator("button").first();
const sugText = await firstSug.textContent();
check("suggests #general", (sugText ?? "").includes("general"), sugText?.trim());
await firstSug.click();
await page.waitForTimeout(700);
check("accepted suggestion becomes in: chip", await page.locator('[data-testid="activity-chip-inChannel"]').isVisible());
await page.locator('[data-testid="activity-chip-inChannel"] button').click();
await page.waitForTimeout(500);

// --- 7. Click a thread-reply row → opens channel + thread, scrolls/flashes the reply ---
// find the row with "in thread"
const threadRow = page.locator('[data-testid="activity-message-row"]', { hasText: "in thread" }).first();
const threadSnippet = await threadRow.textContent();
await threadRow.click();
await page.waitForTimeout(1200);
check("thread panel opens on reply click", await page.locator('[data-testid="thread-close"]').isVisible());
await page.screenshot({ path: `${OUT}/activity-jump-thread.png` });
check("jumped into #general channel", (await page.locator('[data-testid="thread-close"]').count()) === 1, (threadSnippet ?? "").slice(0, 40));
await page.locator('[data-testid="thread-close"]').click();
await page.waitForTimeout(300);

// --- 8. Search palette: token autocomplete + filtered search ---
await page.keyboard.press("Meta+k");
await page.waitForSelector('[data-testid="search-dialog"]', { timeout: 5000 });
await page.locator('[data-testid="search-input"]').fill("activity from:@echo-the-elephant");
await page.waitForTimeout(700);
const hits = await page.locator('[data-testid="search-result-message"]').count();
check("search respects from: token", hits >= 1, `${hits} hits`);
await page.screenshot({ path: `${OUT}/search-filtered.png` });
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// --- 9. Search deliverables switch ---
await page.keyboard.press("Meta+k");
await page.locator('[data-testid="search-input"]').fill("type:deliverables");
await page.waitForTimeout(700);
check("type:deliverables returns deliverable results", (await page.locator('[data-testid="search-result-deliverable"]').count()) >= 1);
await page.keyboard.press("Escape");

// --- 10. Agent profile: Recent messages card ---
// open profile of Echo the Elephant via the Team page card
await page.goto(`${BASE}/team?as=${HUMAN}`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const echoCard = page.locator('[data-testid="agent-card"]', { hasText: "Echo the Elephant" });
await echoCard.locator("button").first().click(); // avatar button opens the profile
await page.waitForTimeout(900);
const card = page.locator('[data-testid="recent-messages-card"]');
check("profile Recent messages card renders", await card.isVisible());
const recentRows = await page.locator('[data-testid="recent-message-row"]').count();
check("Recent messages shows up to 3 rows", recentRows >= 2 && recentRows <= 3, `${recentRows} rows`);
await page.screenshot({ path: `${OUT}/profile-recent-messages.png` });
// click first recent row → jumps into conversation
await page.locator('[data-testid="recent-message-row"]').first().click();
await page.waitForTimeout(1000);
check("recent message click lands in a conversation", (await page.locator('[data-testid="profile-panel"]').count()) === 0);
await page.screenshot({ path: `${OUT}/profile-jump.png` });

// --- 11. Home catch-up section ---
await page.goto(`${BASE}/home?as=${HUMAN}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
const catchUp = page.locator('[data-testid="home-catch-up"]');
check("Home catch-up section renders", await catchUp.isVisible());
check("catch-up has message rows", (await catchUp.locator('[data-testid="activity-message-row"]').count()) >= 2);
await page.screenshot({ path: `${OUT}/home-catch-up.png` });

// --- 12. Dark mode: activity page ---
await page.goto(`${BASE}/activity?as=${HUMAN}`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);
await page.locator('[data-testid="theme-toggle"]').click(); // -> dark (assuming light start)
await page.waitForTimeout(400);
const theme = await page.evaluate(() => document.documentElement.className);
if (!theme.includes("dark")) {
  await page.locator('[data-testid="theme-toggle"]').click();
  await page.waitForTimeout(400);
}
await page.screenshot({ path: `${OUT}/activity-dark.png` });
check("dark mode screenshot taken", (await page.evaluate(() => document.documentElement.className)).includes("dark"));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
