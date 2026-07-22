// Smoke for the accounts + conversation-memory work (run with JUNGLE_ENV_FILE pointing at an
// isolated/preprod env): memory round-trip + window, link-code single-use, and the intake
// follow-up behavior ("actually make it 9am" revises the prior proposal via history).
//   node --import tsx backend/test/liana-accounts-memory.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const db = await import("../src/db/index.ts");
const { runIntake } = await import("../src/services/lianaIntake.ts");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}:`, e.message);
  }
}

// A scratch participant so FKs hold and prod-ish rows stay untouched.
const ws = await db.pool.query(`insert into workspaces (name) values ('memtest-scratch') returning id`);
const wsId = ws.rows[0].id;
const p = await db.createParticipant({
  kind: "human", workspaceId: wsId, handle: `memtest-${randomBytes(3).toString("hex")}`,
  displayName: "Mem Test", firebaseUid: null, email: null, avatarUrl: null,
});
const convo = `imessage:+15550100${Date.now() % 1000}`;

await check("memory: append + read back in order", async () => {
  await db.appendLianaMessage(p.id, convo, "user", "give me a morning briefing every day at 8am");
  await db.appendLianaMessage(p.id, convo, "assistant", 'Here\'s what I\'ll set up:\n\nMorning briefing — every day at 8:00 AM\n\nReply YES to create it, or NO to cancel.');
  const rows = await db.recentLianaMessages(p.id, convo);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].role, "user");
  assert.equal(rows[1].role, "assistant");
});

await check("memory: scoped by convo_key", async () => {
  const other = await db.recentLianaMessages(p.id, "telegram:999");
  assert.equal(other.length, 0);
});

await check("memory: bodies capped at 1500 chars", async () => {
  await db.appendLianaMessage(p.id, "slack:CAP", "user", "x".repeat(9000));
  const rows = await db.recentLianaMessages(p.id, "slack:CAP");
  assert.equal(rows[0].body.length, 1500);
});

await check("memory: window honors limit", async () => {
  for (let i = 0; i < 20; i++) await db.appendLianaMessage(p.id, "slack:LIM", "user", `m${i}`);
  const rows = await db.recentLianaMessages(p.id, "slack:LIM");
  assert.equal(rows.length, 12);
  assert.equal(rows[11].body, "m19"); // newest kept, oldest dropped
});

// Link codes need a liana install row; fabricate a scratch one.
const teamId = `TMEMTEST${Date.now() % 100000}`;
await db.upsertLianaInstall({ teamId, teamName: "Memtest", workspaceId: wsId, botToken: "xoxb-fake", botUserId: "UFAKE", scopes: null });

await check("link code: single-use redeem", async () => {
  const code = randomBytes(16).toString("hex");
  await db.insertLianaLinkCode({ code, teamId, slackUserId: "U123", expiresAt: new Date(Date.now() + 60000).toISOString() });
  const first = await db.consumeLianaLinkCode(code);
  assert.equal(first?.slack_user_id, "U123");
  assert.equal(await db.consumeLianaLinkCode(code), null); // second redeem fails
});

await check("link code: expired codes rejected", async () => {
  const code = randomBytes(16).toString("hex");
  await db.insertLianaLinkCode({ code, teamId, slackUserId: "U123", expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await db.consumeLianaLinkCode(code), null);
});

await check("intake: follow-up revision lands via history (live model call)", async () => {
  const history = await db.recentLianaMessages(p.id, convo);
  const result = await runIntake(
    "actually make it 9am instead",
    {
      userName: "Mem Test",
      userTz: "America/Los_Angeles",
      today: "Wednesday, July 22, 2026",
      existingWorkflows: [],
      history,
    },
    process.env.LIANA_TEST_MODEL ?? "claude-sonnet-5",
  );
  assert.equal(result.intent, "create_workflow");
  assert.ok(result.workflow, "expected a workflow spec");
  assert.match(result.workflow.cron ?? "", /^0 9 /, `cron should be 9am, got ${result.workflow.cron}`);
});

await check("intake: no history means no phantom context (live model call)", async () => {
  const result = await runIntake(
    "actually make it 9am instead",
    { userName: "Mem Test", userTz: null, today: "Wednesday, July 22, 2026", existingWorkflows: [] },
    process.env.LIANA_TEST_MODEL ?? "claude-sonnet-5",
  );
  // Without memory this fragment cannot become the briefing revision; chat is the sane parse.
  assert.notEqual(result.workflow?.prompt?.toLowerCase().includes("briefing"), true);
});

// Cleanup scratch rows (participants first — their workspace FK doesn't cascade).
await db.pool.query(`delete from participants where workspace_id = $1`, [wsId]);
await db.pool.query(`delete from workspaces where id = $1`, [wsId]);
await db.pool.end();

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall good");
