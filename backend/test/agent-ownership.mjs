// Agent ownership (migrations/046): who pays for an agent's turns.
//
// The bug this locks down: `created_by` meant BOTH "who made this" and "who pays for it", and the
// subscription-token and spend-cap lookups took a single hop off it with no kind check. The moment
// @jungle started creating agents, that hop landed on an AGENT — which never holds a subscription
// token — so the agent silently billed the org API key instead of its owner's Claude subscription,
// and its spend rolled up into an invisible 'participant:<agent-id>' account with its own private
// copy of the daily cap. Prod, 2026-07-31: @outreach-agent.
//
// Runs entirely in a throwaway Postgres schema (no backend process, nothing shared with a live
// database) and drives the REAL db/ and services/ownership code by pointing the pool's search_path
// at that schema — so a regression in the actual query, not just a copy of it here, fails the test.
//
//   Run:  DATABASE_URL=postgresql://... node --import tsx test/agent-ownership.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = `owner_test_${process.pid}`;
const BASE_URL = process.env.DATABASE_URL;
if (!BASE_URL) throw new Error("DATABASE_URL is required");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const WS = "00000000-0000-0000-0000-0000000000aa";
const OTHER_WS = "00000000-0000-0000-0000-0000000000bb";
const HUMAN = "aaaaaaaa-0000-0000-0000-000000000001";      // admin, holds a subscription token
const HUMAN2 = "aaaaaaaa-0000-0000-0000-000000000002";     // no token
const OUTSIDER = "aaaaaaaa-0000-0000-0000-000000000003";   // human in a DIFFERENT workspace
const JUNGLE = "bbbbbbbb-0000-0000-0000-000000000001";     // agent created by HUMAN
const CHILD = "bbbbbbbb-0000-0000-0000-000000000002";      // agent created by JUNGLE  <- the bug
const GRANDCHILD = "bbbbbbbb-0000-0000-0000-000000000003"; // agent created by CHILD (2 hops)
const CYCLE_A = "cccccccc-0000-0000-0000-000000000001";    // mutually-creating agents: no human
const CYCLE_B = "cccccccc-0000-0000-0000-000000000002";
const ORPHAN = "dddddddd-0000-0000-0000-000000000001";     // no creator at all

const admin = new pg.Pool({ connectionString: BASE_URL });

async function setup() {
  await admin.query(`drop schema if exists ${SCHEMA} cascade`);
  await admin.query(`create schema ${SCHEMA}`);
  await admin.query(`set search_path = ${SCHEMA}`);
  // Only the columns ownership touches — this is a test of resolution, not of the full schema.
  await admin.query(`
    create table ${SCHEMA}.participants (
      id uuid primary key,
      kind text not null,
      handle text not null,
      display_name text not null,
      role text not null default 'member',
      workspace_id uuid not null,
      created_by uuid references ${SCHEMA}.participants(id) on delete set null,
      claude_oauth_token text,
      email text,
      created_at timestamptz not null default now()
    )`);
  const add = (id, kind, handle, ws, createdBy, opts = {}) =>
    admin.query(
      `insert into ${SCHEMA}.participants (id, kind, handle, display_name, role, workspace_id, created_by, claude_oauth_token, email)
       values ($1,$2,$3,$3,$4,$5,$6,$7,$8)`,
      [id, kind, handle, opts.role ?? "member", ws, createdBy, opts.token ?? null, opts.email ?? null],
    );
  await add(HUMAN, "human", "sahil", WS, null, { role: "admin", token: "sk-ant-oat-TEST", email: "sahil@example.com" });
  await add(HUMAN2, "human", "suhaas", WS, null, { email: "suhaas@example.com" });
  await add(OUTSIDER, "human", "elsewhere", OTHER_WS, null, { role: "admin", email: "out@example.com" });
  await add(JUNGLE, "agent", "jungle", WS, HUMAN);
  await add(CHILD, "agent", "outreach-agent", WS, JUNGLE);
  await add(GRANDCHILD, "agent", "deep-agent", WS, CHILD);
  await add(CYCLE_A, "agent", "cycle-a", WS, null);
  await add(CYCLE_B, "agent", "cycle-b", WS, CYCLE_A);
  await admin.query(`update ${SCHEMA}.participants set created_by = $1 where id = $2`, [CYCLE_B, CYCLE_A]);
  await add(ORPHAN, "agent", "orphan", WS, null);
}

// Apply the migration exactly as it ships. Its statements are unqualified, so search_path decides
// which schema they hit — the same mechanism the test uses for the app code below. The tail of the
// file rewrites one specific prod row by id; harmless here (no such row) and left in deliberately,
// so the test runs the REAL file rather than an edited copy that could drift from it.
async function migrate() {
  const sql = readFileSync(join(here, "../migrations/046_agent_owner.sql"), "utf8");
  const c = await admin.connect();
  try {
    await c.query(`set search_path = ${SCHEMA}`);
    await c.query(sql);
  } finally {
    c.release();
  }
}

async function ownerHandleOf(id) {
  const { rows } = await admin.query(
    `select o.handle from ${SCHEMA}.participants a
       left join ${SCHEMA}.participants o on o.id = a.owner_id where a.id = $1`,
    [id],
  );
  return rows[0]?.handle ?? null;
}

await setup();
await migrate();

// --- the backfill ------------------------------------------------------------------------------

check("human-created agent keeps its creator as owner", (await ownerHandleOf(JUNGLE)) === "sahil");
check(
  "agent created BY AN AGENT is owned by the human behind it (the prod bug)",
  (await ownerHandleOf(CHILD)) === "sahil",
  `got ${await ownerHandleOf(CHILD)}`,
);
check("ownership walks a multi-hop chain", (await ownerHandleOf(GRANDCHILD)) === "sahil");
check("an agent with no creator falls back to the workspace admin", (await ownerHandleOf(ORPHAN)) === "sahil");
// A cycle must terminate, not spin or error: the CYCLE clause stops the walk and the row lands on
// the workspace-admin fallback. Reaching this line at all is most of the assertion.
check("a created_by cycle resolves without hanging", (await ownerHandleOf(CYCLE_A)) === "sahil");
check("both sides of the cycle resolve", (await ownerHandleOf(CYCLE_B)) === "sahil");

const { rows: unowned } = await admin.query(
  `select handle from ${SCHEMA}.participants where kind='agent' and owner_id is null`,
);
check("no agent is left without an owner", unowned.length === 0, unowned.map((r) => r.handle).join(", "));

const { rows: bad } = await admin.query(
  `select a.handle from ${SCHEMA}.participants a join ${SCHEMA}.participants o on o.id = a.owner_id
    where o.kind <> 'human' or o.workspace_id <> a.workspace_id`,
);
check("every owner is a human in the agent's own workspace", bad.length === 0, bad.map((r) => r.handle).join(", "));

check("provenance is preserved — created_by still points at the creating AGENT", await (async () => {
  const { rows } = await admin.query(`select created_by from ${SCHEMA}.participants where id = $1`, [CHILD]);
  return rows[0]?.created_by === JUNGLE;
})());

// --- the real application code, against the test schema ----------------------------------------

process.env.DATABASE_URL = `${BASE_URL}${BASE_URL.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const db = await import("../src/db/index.ts");
const ownership = await import("../src/services/ownership.ts");

check(
  "getClaudeOauthTokenForAgent resolves an agent-created agent to its owner's token",
  (await db.getClaudeOauthTokenForAgent(CHILD)) === "sk-ant-oat-TEST",
  "this returned null before 046 — the whole reason turns billed the org key",
);
check("…and for a normally-created agent", (await db.getClaudeOauthTokenForAgent(JUNGLE)) === "sk-ant-oat-TEST");

check(
  "the spend cap bills an agent-created agent to a real account, not a phantom one",
  (await db.accountKeyForAgent(CHILD)) === "sahil@example.com",
  `got ${await db.accountKeyForAgent(CHILD)}`,
);

check(
  "listAgentIdsOwnedBy reaches agents the owner never personally created",
  (await db.listAgentIdsOwnedBy(HUMAN)).includes(CHILD),
  "otherwise setting/clearing a token silently skips them",
);

// --- the invariant, enforced on write ----------------------------------------------------------

check("setAgentOwner rejects a non-human owner", (await db.setAgentOwner(CHILD, JUNGLE)) === false);
check("setAgentOwner rejects a human from another workspace", (await db.setAgentOwner(CHILD, OUTSIDER)) === false);
check("…and the rejected writes left the owner intact", (await ownerHandleOf(CHILD)) === "sahil");
check("setAgentOwner accepts a human in the same workspace", (await db.setAgentOwner(CHILD, HUMAN2)) === true);
check("…and it took effect", (await ownerHandleOf(CHILD)) === "suhaas");
check(
  "an owner without a subscription falls back to the org key",
  (await db.getClaudeOauthTokenForAgent(CHILD)) === null,
);

// --- ownerForNewAgent: what an agent creating an agent assigns ---------------------------------

await db.setAgentOwner(CHILD, HUMAN);
const jungleRow = await db.getParticipant(JUNGLE);
const humanRow = await db.getParticipant(HUMAN);
check(
  "an agent creating an agent passes its OWN owner down",
  (await ownership.ownerForNewAgent(jungleRow, WS)) === HUMAN,
);
check("a human creating an agent owns it", (await ownership.ownerForNewAgent(humanRow, WS)) === HUMAN);
check(
  "a creator from another workspace is refused ownership",
  (await ownership.ownerForNewAgent(await db.getParticipant(OUTSIDER), WS)) === null,
);

// --- self-heal ---------------------------------------------------------------------------------

await admin.query(`update ${SCHEMA}.participants set owner_id = null where id = $1`, [CHILD]);
const healed = await ownership.healOwnerlessAgents(WS);
check("healOwnerlessAgents re-adopts an agent whose owner was cleared", healed >= 1);
check("…via the created_by chain, back to the right human", (await ownerHandleOf(CHILD)) === "sahil");

await admin.query(`drop schema ${SCHEMA} cascade`);
await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
