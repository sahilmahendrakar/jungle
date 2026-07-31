// Focused Playwright test for deleting messages in the timeline:
//   - the trash action appears on your OWN message and on an AGENT's, never on another human's
//   - confirming removes the row live (no reload) — and removes it for the other person's tab too
//   - a deleted thread root stays as a "This message was deleted" tombstone with its replies
// Usage: TEST_DATABASE_URL=… node test/ui-message-delete.mjs <frontendUrl> <backendPort>
// Seeds its own workspace/channel, so it needs no fixtures. Assumes a dev-bypass backend.
import { chromium } from "playwright";
import pg from "pg";

const URL = process.argv[2] ?? "http://localhost:5183";
const PORT = process.argv[3] ?? "3061";
const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) throw new Error("usage: TEST_DATABASE_URL=… node ui-message-delete.mjs <url> <port>");
const pool = new pg.Pool({ connectionString: TEST_DB });
const tag = Date.now().toString(36).slice(-5);

let fail = 0;
const log = (...a) => console.log(...a);
const check = (n, ok) => { log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) fail++; };
const shot = (p, name) => p.screenshot({ path: `/tmp/ui-msgdel-${name}.png` }).catch(() => {});

// Seed directly: two humans, an agent, a channel, and the messages under test (posting through
// the UI is covered elsewhere — this test is about the delete affordance).
async function seed() {
  const ws = (await pool.query(`insert into workspaces (name) values ($1) returning id`, [`uidel-${tag}`]))
    .rows[0].id;
  const human = async (name) =>
    (await pool.query(
      `insert into participants (kind, handle, display_name, workspace_id, role)
       values ('human',$1,$2,$3,'member') returning id`,
      [`${name}-${tag}`, name, ws],
    )).rows[0].id;
  const alice = await human("Alice");
  const bob = await human("Bob");
  const agent = (await pool.query(
    `insert into participants
       (kind, handle, display_name, mode, effort, runtime, runner_provider, workspace_id, role)
     values ('agent',$1,'Robot','bypassPermissions','medium','sdk','docker',$2,'member') returning id`,
    [`robot-${tag}`, ws],
  )).rows[0].id;
  const channel = (await pool.query(
    `insert into channels (name, kind, workspace_id) values ($1,'channel',$2) returning id`,
    [`uidel-${tag}`, ws],
  )).rows[0].id;
  for (const p of [alice, bob, agent]) {
    await pool.query(`insert into channel_members (channel_id, participant_id) values ($1,$2)`, [channel, p]);
  }
  const say = async (sender, body, rootId = null) =>
    (await pool.query(
      `insert into messages (channel_id, sender_id, body, thread_root_id) values ($1,$2,$3,$4) returning id`,
      [channel, sender, body, rootId],
    )).rows[0].id;
  const mine = await say(alice, "mine to delete");
  const theirs = await say(bob, "bob's message");
  const agentMsg = await say(agent, "agent output");
  const root = await say(alice, "thread root here");
  await say(bob, "a reply that must survive", root);
  await pool.query(`update messages set reply_count = 1, last_reply_at = now() where id = $1`, [root]);
  return { alice, bob, channel, mine, theirs, agentMsg, root };
}

const browser = await chromium.launch();
try {
  const { alice, bob, channel, mine, theirs, agentMsg, root } = await seed();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => log("PAGEERROR:", e.message));

  const row = (p, id) => p.locator(`[data-message-id="${id}"]`);
  const trash = (p, id) => row(p, id).locator('[data-testid="message-delete"]');

  await page.goto(`${URL}/?as=${alice}`, { waitUntil: "networkidle" });
  await page.getByText(`uidel-${tag}`).first().click();
  await page.waitForTimeout(800);
  check("channel history rendered", await row(page, mine).isVisible());

  // --- the affordance, hover by hover ---
  await row(page, mine).hover();
  check("my own message offers delete", await trash(page, mine).isVisible());
  await row(page, agentMsg).hover();
  check("an agent's message offers delete", await trash(page, agentMsg).isVisible());
  await row(page, theirs).hover();
  check("another human's message does NOT", (await trash(page, theirs).count()) === 0);
  await shot(page, "hover");

  // --- a second tab as Bob, to prove the delete lands live for everyone ---
  const bobPage = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await bobPage.goto(`${URL}/?as=${bob}`, { waitUntil: "networkidle" });
  await bobPage.getByText(`uidel-${tag}`).first().click();
  await bobPage.waitForTimeout(800);
  check("bob sees the message before it goes", await row(bobPage, mine).isVisible());

  await row(page, mine).hover();
  await trash(page, mine).click();
  await page.locator('[data-testid="confirm-delete-message"]').click();
  await page.waitForTimeout(1200);
  check("deleted message leaves my timeline", (await row(page, mine).count()) === 0);
  check("...and bob's, without a reload", (await row(bobPage, mine).count()) === 0);
  await shot(page, "after-delete");

  // --- a thread root leaves a tombstone, not a hole ---
  await row(page, root).hover();
  await trash(page, root).click();
  await page.locator('[data-testid="confirm-delete-message"]').click();
  await page.waitForTimeout(1200);
  check("the deleted root is still on screen", await row(page, root).isVisible());
  check(
    "...as a tombstone",
    await row(page, root).locator('[data-testid="message-tombstone"]').isVisible(),
  );
  check("its reply chip survives", await row(page, root).locator('[data-testid="thread-replies"]').isVisible());
  await shot(page, "tombstone");

  // The thread still opens and shows the surviving reply under the tombstone.
  await row(page, root).locator('[data-testid="thread-replies"]').click();
  await page.waitForTimeout(600);
  check("the thread still opens", await page.getByText("a reply that must survive").first().isVisible());
  await shot(page, "thread");
  void channel;
} finally {
  await browser.close();
  await pool.end();
}
log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
