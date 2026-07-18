// Focused Playwright test for composer mention badges + create-agent dialog defaults:
//   - resolved @handles render as badges inside the composer (same component as chat history:
//     hover opens the agent card, click opens the profile) in the main + thread composers
//   - the mirror overlay stays pixel-aligned with the real textarea text (incl. scrolling)
//   - Tool permissions is top-level in the create-agent dialog (no Advanced toggle), and the
//     environment/model/permissions from the last create are saved + prefilled next time
// Usage: node test/ui-composer-badges.mjs <frontendUrl> <humanParticipantId>
import { chromium } from "playwright";

const URL = process.argv[2];
const HUMAN = process.argv[3];
let fail = 0;
const log = (...a) => console.log(...a);
const check = (n, ok) => { log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) fail++; };
const shot = (p, name) => p.screenshot({ path: `/tmp/ui-badges-${name}.png` }).catch(() => {});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => log("PAGEERROR:", e.message));

const handle = `badgebot-${Date.now().toString(36).slice(-4)}`;
const composer = page.locator('[data-testid="composer-input"]');
// The mirror overlay is the aria-hidden sibling after the textarea inside ComposerInput.
const mirrorBadges = page.locator('div[aria-hidden="true"] [data-testid="mention-badge"]');

try {
  await page.goto(`${URL}/?as=${HUMAN}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  // --- create-agent dialog: permissions top-level, defaults saved + prefilled ---
  await page.locator('[data-testid="add-agent-toggle"]').first().click();
  await page.waitForTimeout(500);
  check("dialog: tool permissions visible without expanding anything", await page.locator('[data-testid="agent-mode"]').isVisible().catch(() => false));
  check("dialog: no Advanced toggle", (await page.locator("text=Advanced").count()) === 0);
  check("dialog: no saved defaults before first create", await page.evaluate(() => localStorage.getItem("jungle:add-agent-defaults:v1")) === null);
  await page.locator('[data-testid="agent-handle"]').fill(handle);
  await page.locator('[data-testid="agent-name"]').fill("Badge Bot");
  // Non-default model + permissions so prefill proves it restored OUR choices, not the globals.
  await page.locator('[data-testid="agent-model"]').click();
  await page.locator('[data-testid="agent-model-option"]', { hasText: "Sonnet 5" }).click();
  await page.locator('[data-testid="agent-mode"]').click();
  await page.locator('[data-testid="agent-mode-option"]', { hasText: "Plan only" }).click();
  await page.locator('[data-testid="add-agent-button"]').click();
  await page.waitForTimeout(1200);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("jungle:add-agent-defaults:v1") ?? "null"));
  check("dialog: env/model/mode saved on create", !!saved && saved.mode === "plan" && !!saved.model && saved.env === "cloud");

  // Reopen → prefilled from the last create.
  await page.locator('[data-testid="add-agent-toggle"]').first().click();
  await page.waitForTimeout(700);
  check("dialog: permissions prefilled from last create", (await page.locator('[data-testid="agent-mode"]').textContent())?.includes("Plan only"));
  check("dialog: model prefilled from last create", (await page.locator('[data-testid="agent-model"]').textContent())?.includes("Sonnet 5"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // --- composer mention badges (main composer) ---
  await page.locator('[data-testid="channel-item"]').first().click();
  await page.waitForTimeout(800);
  await composer.click();
  // Full handle: earlier runs leave "Badge Bot" agents behind, and a shared prefix can make
  // the autocomplete accept one of those instead.
  await composer.pressSequentially(`@${handle}`);
  check("composer: autocomplete popup opens", await page.locator('[data-testid="mention-popup"]').waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false));
  await page.keyboard.press("Enter"); // accept -> "@handle "
  await page.waitForTimeout(300);
  check("composer: badge renders for known handle", (await mirrorBadges.count()) === 1);
  check("composer: badge shows the raw handle", (await mirrorBadges.first().textContent()) === `@${handle}`);
  check("composer: textarea keeps the raw text", (await composer.inputValue()) === `@${handle} `);
  await shot(page, "composer-badge");

  // Unknown handles stay plain text (no badge).
  await composer.fill(`@${handle} and @not-a-real-handle here`);
  await page.waitForTimeout(200);
  check("composer: unknown handle gets no badge", (await mirrorBadges.count()) === 1);

  // Alignment: badge must start exactly where the raw text sits (canvas-measured).
  await composer.fill(`@${handle} tail`);
  const align = await page.evaluate((h) => {
    const ta = document.querySelector('[data-testid="composer-input"]');
    const badge = ta.nextElementSibling.querySelector('[data-testid="mention-badge"]');
    const cs = getComputedStyle(ta);
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const taRect = ta.getBoundingClientRect();
    const bRect = badge.getBoundingClientRect();
    return {
      dx: bRect.left - (taRect.left + parseFloat(cs.paddingLeft) + ctx.measureText(ta.value.split(h)[0]).width),
      dy: bRect.top - (taRect.top + parseFloat(cs.paddingTop)),
    };
  }, `@${handle}`);
  check("composer: badge pixel-aligned with text", Math.abs(align.dx) < 2 && Math.abs(align.dy) < 4);

  // Scroll sync: content past max-h scrolls; the mirror must follow the textarea.
  await composer.fill(Array.from({ length: 20 }, (_, i) => `line ${i} @${handle}`).join("\n"));
  await page.evaluate(() => {
    const ta = document.querySelector('[data-testid="composer-input"]');
    ta.scrollTop = ta.scrollHeight;
    ta.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const sync = await page.evaluate(() => {
    const ta = document.querySelector('[data-testid="composer-input"]');
    return { ta: ta.scrollTop, mirror: ta.nextElementSibling.scrollTop };
  });
  check("composer: mirror scrolls in lockstep", Math.abs(sync.ta - sync.mirror) < 2);

  // Hover → agent card; click → profile panel. Same affordances as the chat-history badge.
  await composer.fill(`@${handle} hi`);
  await page.waitForTimeout(200);
  await mirrorBadges.first().hover();
  check("composer: hover opens the agent card", await page.locator('[data-testid="agent-hover-card"]').waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false));
  await page.mouse.move(30, 300);
  await page.waitForTimeout(400);
  await mirrorBadges.first().click();
  await page.waitForTimeout(600);
  check("composer: click opens the profile", await page.locator('[data-testid="profile-panel"]').waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false));
  await page.locator('[data-testid="profile-close"]').click().catch(() => page.keyboard.press("Escape"));
  await page.waitForTimeout(400);

  // Send: draft + badges clear; the posted message renders the history badge (display name).
  await composer.fill(`@${handle} hello from the badge test`);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  check("composer: draft + mirror clear on send", (await composer.inputValue()) === "" && (await mirrorBadges.count()) === 0);
  const historyBadge = page.locator('[data-testid="message-list"] [data-testid="mention-badge"]').last();
  check("history: sent message shows the badge", (await historyBadge.textContent()) === "@Badge Bot");

  // --- thread composer ---
  await historyBadge.hover();
  const replyBtn = page.locator('[data-testid="reply-in-thread"]').first();
  if (await replyBtn.count()) {
    await replyBtn.click();
    await page.waitForTimeout(600);
    const tComposer = page.locator('[data-testid="thread-composer-input"]');
    await tComposer.fill(`@${handle} in a thread`);
    await page.waitForTimeout(300);
    check("thread: badge renders in the thread composer", (await mirrorBadges.count()) > 0);
    await shot(page, "thread-composer-badge");
  } else {
    log("SKIP thread composer (no reply-in-thread button)");
  }
} catch (e) {
  log("ERROR:", e.message);
  fail++;
  await shot(page, "error");
}

await browser.close();
log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
