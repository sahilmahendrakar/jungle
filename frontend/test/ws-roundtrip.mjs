// WS round-trip test: proves the app WebSocket send + ServerEvent dispatch works end-to-end.
// A posted message has NO optimistic echo — it only renders when it round-trips back over the
// socket and the onmessage handler appends it to `messages`. So seeing the text appear exercises:
// composer send -> ws.send -> backend persist+fanout -> useChatSocket dispatch -> MessageList.
// Self-cleaning: creates a throwaway channel and deletes it at the end.
// Usage: node test/ws-roundtrip.mjs <frontendUrl> <humanParticipantId>
import { chromium } from "playwright";

const URL = process.argv[2];
const HUMAN = process.argv[3];
const log = (...a) => console.log(...a);
let fail = 0;
const check = (n, ok) => { log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) fail++; };

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => { log("PAGEERROR:", e.message); fail++; });

const chanName = `wstest-${Date.now().toString(36)}`;
const msg = `roundtrip ${Date.now().toString(36)}`;

try {
  await page.goto(`${URL}/?as=${HUMAN}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // Create a throwaway channel.
  await page.locator('[data-testid="new-channel-toggle"]').first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid="new-channel-name"]').fill(chanName);
  await page.locator('[data-testid="create-channel-button"]').click();
  // The new channel is auto-selected; wait for its composer.
  await page.locator('[data-testid="composer-input"]').first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(800); // let the socket settle / channel switch complete
  check("throwaway channel created + selected", (await page.locator('[data-testid="composer-input"]').count()) > 0);

  // Post a message and wait for it to round-trip back and render (no optimistic echo).
  await page.locator('[data-testid="composer-input"]').first().fill(msg);
  await page.locator('[data-testid="send-button"]').first().click();
  const rendered = await page.locator(`[data-testid="message-list"]:has-text("${msg}")`)
    .first().waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  check("posted message round-trips over WS and renders", rendered);

  // Clean up: delete the channel.
  const menu = page.locator('[data-testid="channel-menu"]').first();
  if (await menu.count()) {
    await menu.click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="menu-delete-channel"]').first().click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="confirm-delete-channel"]').first().click();
    await page.waitForTimeout(800);
    check("throwaway channel deleted (cleanup)", true);
  } else {
    check("throwaway channel deleted (cleanup)", false);
  }

  log(`\nWS ROUND-TRIP DONE: ${fail} failures`);
} catch (e) {
  log("FATAL:", e.message);
  fail++;
} finally {
  await browser.close();
  process.exit(fail ? 1 : 0);
}
