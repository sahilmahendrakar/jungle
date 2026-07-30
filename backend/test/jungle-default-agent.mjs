// @jungle, the workspace's default agent (services/jungleAgent.ts).
//
// What this pins:
//   1. ensureJungleAgent creates exactly one marked agent per workspace, and is idempotent.
//   2. It attaches jungle-admin (no backing account needed) even in a workspace where nobody has
//      connected anything — the whole point of skipping unresolvable integrations rather than
//      failing the create the way agentAdmin.createAgentAs does.
//   3. A connection-based default (notion) is skipped at creation and picked up later by
//      syncJungleIntegrations, once somebody in the workspace has connected it.
//   4. The default agent doesn't consume the workspace's agent cap.
//   5. Members can't rename or delete it.
//   6. "jungle" is reserved, so nobody else can take the handle the agent is reached at.
//
// Runs entirely against the service/db layer (no HTTP, no auth) in throwaway workspaces that are
// dropped at the end. Provisioning is fired in the background by ensureJungleAgent and is expected
// to fail here (no Fly credentials in a dev shell) — it's caught and logged, and never affects the
// DB rows these assertions read.
//
// Run:  set -a; . .env; set +a; npx tsx backend/test/jungle-default-agent.mjs
import * as db from "../src/db/index.ts";
import { registerBuiltinIntegrations } from "../src/integrations/index.ts";
import { ensureJungleAgent, syncJungleIntegrations, JUNGLE_HANDLE } from "../src/services/jungleAgent.ts";
import { updateAgentConfigAs, deleteAgentAs, createAgentAs } from "../src/services/agentAdmin.ts";

// index.ts does this at boot; without it adapterFor() finds nothing and every attach would store
// raw config — silently "succeeding" at binding integrations that have no account behind them.
registerBuiltinIntegrations();

const sfx = Date.now().toString(36);
const made = [];
let failures = 0;

const check = (label, cond, detail) => {
  if (cond) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
};

// The error an operation rejects with, or null if it unexpectedly succeeded.
const rejection = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

async function freshWorkspace(name) {
  const { workspace, participant } = await db.createWorkspaceWithCreator({
    name: `${name} ${sfx}`,
    handle: `owner-${sfx}-${made.length}`,
    displayName: "Owner",
  });
  made.push(workspace.id);
  return { workspace, owner: participant };
}

async function main() {
  // --- 1 + 2: creation in a workspace with no connections at all ---------------------------------
  console.log("\ncreate in an unconnected workspace");
  const { workspace, owner } = await freshWorkspace("Jungle default");
  const agent = await ensureJungleAgent(workspace.id);
  check("agent is marked as the default", agent.jungle_default === true);
  check("handle is @jungle", agent.handle === JUNGLE_HANDLE, `got @${agent.handle}`);
  check("has no owner (belongs to the workspace)", agent.created_by === null);
  check("is an sdk agent", agent.kind === "agent" && agent.runtime === "sdk");
  check("has a persona", (agent.persona?.length ?? 0) > 0);

  const keysOf = async (id) =>
    (await db.listAgentIntegrations(id)).map((r) => r.integration_key).sort();
  const initial = await keysOf(agent.id);
  check("jungle-admin attached with no connection present", initial.includes("jungle-admin"), `got ${initial}`);
  check("notion skipped (nobody connected it)", !initial.includes("notion"), `got ${initial}`);

  // --- 1: idempotence ---------------------------------------------------------------------------
  console.log("\nidempotence");
  const again = await ensureJungleAgent(workspace.id);
  check("returns the same agent", again.id === agent.id);
  const agentRows = (await db.listParticipants(workspace.id)).filter((p) => p.jungle_default);
  check("exactly one default agent in the workspace", agentRows.length === 1, `got ${agentRows.length}`);

  // --- 3: a connection appears later ------------------------------------------------------------
  console.log("\nretro-attach once someone connects");
  await db.createIntegrationConnection({
    participantId: owner.id,
    key: "notion",
    externalAccount: "Test Notion",
    accessToken: "test-token",
    refreshToken: null,
    accessExpiresAt: null,
    scopes: null,
  });
  await syncJungleIntegrations(workspace.id);
  const afterConnect = await keysOf(agent.id);
  check("notion attached after the connect", afterConnect.includes("notion"), `got ${afterConnect}`);
  const notion = await db.getAgentIntegration(agent.id, "notion");
  check("notion bound to the connecting person's account", typeof notion?.config?.connectionId === "string");

  // --- 4: the cap ------------------------------------------------------------------------------
  console.log("\nagent cap");
  await db.withTransaction(async (client) => {
    const { count } = await db.agentCountAndCap(client, workspace.id);
    check("default agent doesn't count against the cap", count === 0, `counted ${count}`);
  });

  // --- 5: rename + delete are refused -----------------------------------------------------------
  console.log("\nrename + delete are refused");
  const renameErr = await rejection(() =>
    updateAgentConfigAs(owner, agent.id, { displayName: "Renamed" }),
  );
  check("rename rejected", renameErr !== null, "rename unexpectedly succeeded");
  check("rename error explains why", /default agent/.test(renameErr?.message ?? ""), renameErr?.message);

  const deleteErr = await rejection(() => deleteAgentAs(owner, agent.id));
  check("delete rejected", deleteErr !== null, "delete unexpectedly succeeded");
  check("agent still exists", (await db.getParticipant(agent.id)) !== null);

  // Editing what SHOULD stay editable still works.
  const repersonad = await updateAgentConfigAs(owner, agent.id, { persona: "Edited persona." });
  check("persona still editable", repersonad?.persona === "Edited persona.");

  // --- 6: the handle is reserved ----------------------------------------------------------------
  console.log("\nreserved handle");
  check("handleAvailable says jungle is taken", (await db.handleAvailable(workspace.id, "jungle")) === false);
  const other = await freshWorkspace("Reserved handle");
  check(
    "reserved even in a workspace with no default agent yet",
    (await db.handleAvailable(other.workspace.id, "JUNGLE")) === false,
  );
  const takeErr = await rejection(() =>
    createAgentAs(other.owner, { handle: "jungle", displayName: "Impostor" }),
  );
  check("an agent can't be created on the jungle handle", takeErr !== null, "create unexpectedly succeeded");

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
}

main()
  .catch((e) => {
    failures++;
    console.error("\nunexpected error:", e);
  })
  .finally(async () => {
    // channels + participants are ON DELETE NO ACTION, so they have to go before the workspace
    // (everything else — integrations, connections, messages — cascades off those). Cleanup
    // failures are reported, not swallowed: silently leaving rows behind pollutes the dev DB and
    // makes the next run's "is this handle free" assertions lie.
    for (const id of made) {
      try {
        await db.pool.query(`delete from channels where workspace_id = $1`, [id]);
        await db.pool.query(`delete from participants where workspace_id = $1`, [id]);
        await db.pool.query(`delete from workspaces where id = $1`, [id]);
      } catch (e) {
        failures++;
        console.error(`cleanup of workspace ${id} failed:`, e.message);
      }
    }
    await db.pool.end();
    process.exit(failures ? 1 : 0);
  });
