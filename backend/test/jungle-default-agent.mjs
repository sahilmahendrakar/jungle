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
//   7. Every member has an open DM with it, including people who joined before it existed — an
//      unopened DM isn't in listChannels at all, so the channel has to exist for @jungle to show
//      up in the sidebar.
//   8. The boot sweep reconciles workspaces that ALREADY have an agent (heals integrations + DMs),
//      and only skips Liana's own Slack workspaces. It used to skip any workspace holding a
//      liana_conductor, which wrongly skipped real workspaces: Liana reuses a user's existing
//      Jungle workspace and puts its conductor inside it.
//
// Runs entirely against the service/db layer (no HTTP, no auth) in throwaway workspaces that are
// dropped at the end. Provisioning is fired in the background by ensureJungleAgent and is expected
// to fail here (no Fly credentials in a dev shell) — it's caught and logged, and never affects the
// DB rows these assertions read.
//
// Run:  set -a; . .env; set +a; npx tsx backend/test/jungle-default-agent.mjs
import * as db from "../src/db/index.ts";
import { registerBuiltinIntegrations } from "../src/integrations/index.ts";
import {
  ensureJungleAgent,
  syncJungleIntegrations,
  ensureJungleDmFor,
  backfillJungleAgents,
  JUNGLE_HANDLE,
} from "../src/services/jungleAgent.ts";
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
  // @jungle only exists where somebody is on a Claude subscription — see JUNGLE_MODEL's comment.
  await db.setClaudeOauthToken(participant.id, `sk-ant-oat-test-${sfx}-${made.length}-padpadpadpadpadpadpadpad`);
  return { workspace, owner: participant };
}

async function main() {
  // --- 1 + 2: creation in a workspace with no connections at all ---------------------------------
  console.log("\ncreate in an unconnected workspace");
  const { workspace, owner } = await freshWorkspace("Jungle default");
  const agent = await ensureJungleAgent(workspace.id);
  check("agent is marked as the default", agent.jungle_default === true);
  check("handle is @jungle", agent.handle === JUNGLE_HANDLE, `got @${agent.handle}`);
  check("is an sdk agent", agent.kind === "agent" && agent.runtime === "sdk");
  check("has a persona", (agent.persona?.length ?? 0) > 0);
  check("runs on Opus 5", agent.model === "claude-opus-5", `got ${agent.model}`);
  check("is owned by the subscriber", agent.created_by === owner.id);
  check("…so its turns bill to their subscription",
    (await db.getClaudeOauthTokenForAgent(agent.id)) !== null);

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

  // --- 7: DMs ----------------------------------------------------------------------------------
  console.log("\nmember DMs");
  const dmsOf = async (participantId) =>
    (await db.listChannels(participantId)).filter((c) => c.kind === "dm");
  const ownerDms = await dmsOf(owner.id);
  check("the workspace creator has a DM with @jungle", ownerDms.some((c) => c.dm_with === agent.handle),
    `got ${JSON.stringify(ownerDms.map((c) => c.dm_with))}`);

  // Somebody who joins after @jungle already exists.
  const latecomer = await db.createParticipant({
    kind: "human", workspaceId: workspace.id, handle: `late-${sfx}`, displayName: "Latecomer",
  });
  await ensureJungleDmFor(latecomer);
  check("a member who joins later gets one too",
    (await dmsOf(latecomer.id)).some((c) => c.dm_with === agent.handle));

  // …and somebody who was already there before the sweep runs (the backfill case).
  const earlier = await db.createParticipant({
    kind: "human", workspaceId: workspace.id, handle: `early-${sfx}`, displayName: "Earlier",
  });
  check("…who has none before the sweep", (await dmsOf(earlier.id)).length === 0);
  await ensureJungleAgent(workspace.id);
  check("the sweep opens the missing DM", (await dmsOf(earlier.id)).some((c) => c.dm_with === agent.handle));

  const before = (await dmsOf(owner.id)).length;
  await ensureJungleAgent(workspace.id);
  check("re-running doesn't duplicate DMs", (await dmsOf(owner.id)).length === before, `went ${before} -> ${(await dmsOf(owner.id)).length}`);

  // --- 8: the sweep's worklist ------------------------------------------------------------------
  console.log("\nboot sweep worklist");
  const eligible = await db.listWorkspaceIdsForJungleAgent();
  check("includes a workspace that already has an agent", eligible.includes(workspace.id));

  // A liana_conductor in a workspace must NOT exclude it — this is the bug that left real
  // workspaces without an @jungle.
  const conductorWs = await freshWorkspace("Has a conductor");
  await db.createParticipant({
    kind: "agent", workspaceId: conductorWs.workspace.id, handle: `liana-${sfx}`,
    displayName: "Liana", runtime: "sdk", lianaConductor: true,
  });
  check("a workspace holding a liana_conductor is still eligible",
    (await db.listWorkspaceIdsForJungleAgent()).includes(conductorWs.workspace.id));
  // …and so is one with an active Liana Slack install. That filter skipped the seed workspace —
  // a workspace people work in daily can have Liana's Slack app installed too.
  const slackWs = await freshWorkspace("Has a slack install");
  await db.pool.query(
    `insert into liana_slack_installs (workspace_id, team_id, team_name, bot_token, bot_user_id, status)
     values ($1, $2, 'Test', 'xoxb-test', 'U-test', 'active')`,
    [slackWs.workspace.id, `T${sfx}`],
  );
  check("a workspace with an active Liana Slack install is still eligible",
    (await db.listWorkspaceIdsForJungleAgent()).includes(slackWs.workspace.id));
  await backfillJungleAgents();
  check("…and the sweep gives it an agent",
    (await db.getJungleAgent(conductorWs.workspace.id)) !== null);

  // --- 9: the subscription gate -----------------------------------------------------------------
  console.log("\nsubscription gate");
  const { workspace: bare } = await db.createWorkspaceWithCreator({
    name: `No subscription ${sfx}`, handle: `nosub-${sfx}`, displayName: "Nosub",
  });
  made.push(bare.id);
  check("no agent where nobody has a subscription", (await ensureJungleAgent(bare.id)) === null);
  check("…and none was created", (await db.getJungleAgent(bare.id)) === null);

  // Someone sets a token -> it appears on the next sweep.
  const bareOwner = (await db.listParticipants(bare.id)).find((p) => p.kind === "human");
  await db.setClaudeOauthToken(bareOwner.id, `sk-ant-oat-test-${sfx}-late-padpadpadpadpadpadpadpad`);
  const late = await ensureJungleAgent(bare.id);
  check("appears once someone subscribes", late !== null && late.created_by === bareOwner.id);

  // An agent created before it had an owner gets adopted rather than left billing the org key.
  await db.setAgentCreatedBy(late.id, null);
  await db.updateAgentConfig(late.id, { model: "claude-sonnet-5" });
  await ensureJungleAgent(bare.id);
  const adopted = await db.getJungleAgent(bare.id);
  check("an ownerless agent is adopted by the subscriber", adopted.created_by === bareOwner.id);
  check("…and moved onto Opus 5", adopted.model === "claude-opus-5", `got ${adopted.model}`);

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
