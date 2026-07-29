// Agent-initiated attach of a connection-based integration (integrations/backing.ts).
//
// The bug this pins: an agent using the jungle-admin MCP tools (or an agent-bound API token) could
// never attach notion/gmail/linear/… — resolveConfig required the connection to belong to the
// ACTOR, and an agent has no Settings page and never holds one, so the attach always failed with
// "connect your Notion account in Settings first" no matter how many times the human reconnected.
// Now it binds to the account of the person the agent is acting for, and a failed attach during
// create_agent no longer strands a half-created agent.
//
// Everything runs in a throwaway workspace (POST /api/_dev/workspaces) so the "who in this
// workspace has connected it" resolution can't be perturbed by real connections in the dev DB.
//
// Run:  set -a; . .env; set +a; node backend/test/agent-attach-integration.mjs
//       BASE=http://localhost:3101 node backend/test/agent-attach-integration.mjs
import pg from "pg";

const BASE = process.env.BASE ?? "http://localhost:3001";
const sfx = Date.now().toString(36);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

let pass = false;
let wsId, aliceId, bobId, archId, targetId, tokenId, humanTokenId, madeHandle;

const post = (path, body) =>
  fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

let rpcId = 0;
// One tools/call. Returns { text, isError } — these assertions care about the failures too.
async function call(token, name, args = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${name}: rpc error ${JSON.stringify(body.error)}`);
  return { text: body.result?.content?.[0]?.text ?? "", isError: !!body.result?.isError };
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log(`ok: ${msg}`);
};

const addAgent = async (handle, createdBy = null) =>
  (
    await pool.query(
      `insert into participants (kind, workspace_id, handle, display_name, runtime, created_by)
       values ('agent', $1, $2, $3, 'sdk', $4) returning id`,
      [wsId, handle, handle, createdBy],
    )
  ).rows[0].id;

// A stand-in for "this person connected Notion in Settings" — the tokens are never used here, only
// the row's existence. Returns the connection id, which is what an attach now binds to.
const connectNotion = async (participantId, workspaceName) =>
  (
    await pool.query(
      `insert into integration_connections
         (participant_id, integration_key, external_account, access_token, refresh_token, extra)
       values ($1, 'notion', $2, 'fake-access', 'fake-refresh', '{}'::jsonb) returning id`,
      [participantId, `Notion · ${workspaceName}`],
    )
  ).rows[0].id;

const boundTo = async (agentId) =>
  (
    await pool.query(`select config from agent_integrations where agent_id = $1 and integration_key = 'notion'`, [
      agentId,
    ])
  ).rows[0]?.config?.connectionId ?? null;

const detach = (token, agentHandle) => call(token, "detach_integration", { agent: agentHandle, key: "notion" });

try {
  // -- a throwaway workspace: alice (its creator) + bob; an acting agent alice made, and a target --
  const ws = await post("/api/_dev/workspaces", { name: `attach-${sfx}`, handle: `alice${sfx}` });
  wsId = ws.workspace?.id;
  aliceId = ws.participant?.id;
  assert(wsId && aliceId, "created an isolated workspace with a human creator");
  bobId = (
    await pool.query(
      `insert into participants (kind, workspace_id, handle, display_name)
       values ('human', $1, $2, 'Bob') returning id`,
      [wsId, `bob${sfx}`],
    )
  ).rows[0].id;
  const arch = `@arch${sfx}`;
  const target = `@target${sfx}`;
  archId = await addAgent(`arch${sfx}`, aliceId); // created_by alice — she owns it
  targetId = await addAgent(`target${sfx}`, aliceId);

  const mint = await post(`/api/tokens?participantId=${aliceId}`, { name: `attach e2e ${sfx}`, participantId: archId });
  tokenId = mint.id;
  const agentToken = mint.token;
  assert(agentToken?.startsWith("jgl_"), "minted an agent-bound token for the acting agent");

  // -- nobody has connected Notion: a precise error, not "connect your Notion account" --
  const none = await call(agentToken, "attach_integration", { agent: target, key: "notion" });
  assert(none.isError, "attach fails while nobody in the workspace has connected Notion");
  assert(
    none.text.includes("nobody in this workspace has connected Notion") && !none.text.includes("connect your Notion"),
    "the error names the real problem instead of telling the agent to open Settings",
  );

  // -- one connected person: the attach binds to their account --
  const aliceCrm = await connectNotion(aliceId, "CRM");
  const one = await call(agentToken, "attach_integration", { agent: target, key: "notion" });
  assert(!one.isError, `agent attaches Notion once a person has connected it (${one.text})`);
  assert((await boundTo(targetId)) === aliceCrm, "it is bound to that person's connection");

  // -- two people connected: the agent's OWNER (participants.created_by) wins, no ambiguity --
  await detach(agentToken, target);
  const bobCrm = await connectNotion(bobId, "Bob's notes");
  const owned = await call(agentToken, "attach_integration", { agent: target, key: "notion" });
  assert(!owned.isError, `two people connected, but the acting agent's owner settles it (${owned.text})`);
  assert((await boundTo(targetId)) === aliceCrm, "…bound to the owner's connection, not the other person's");

  // -- an agent with no recorded creator (made before created_by existed) must ask --
  await detach(agentToken, target);
  await pool.query(`update participants set created_by = null where id = $1`, [archId]);
  const many = await call(agentToken, "attach_integration", { agent: target, key: "notion" });
  assert(many.isError, "an ownerless agent can't guess between two connected people");
  assert(
    many.text.includes(`@alice${sfx}`) && many.text.includes(`@bob${sfx}`) && many.text.includes("onBehalfOf"),
    "the error lists the candidates and how to choose one",
  );

  const named = await call(agentToken, "attach_integration", { agent: target, key: "notion", onBehalfOf: `@bob${sfx}` });
  assert(!named.isError, `onBehalfOf resolves the ambiguity (${named.text})`);
  assert((await boundTo(targetId)) === bobCrm, "it is bound to the named person's connection");

  const asAgent = await call(agentToken, "attach_integration", { agent: target, key: "notion", onBehalfOf: arch });
  assert(asAgent.isError && asAgent.text.includes("must be a person"), "onBehalfOf rejects an agent");

  // -- one person, several Notion workspaces (what #102 made possible): name the connection --
  const aliceSide = await connectNotion(aliceId, "Side project");
  await detach(agentToken, target);
  const twoOfHers = await call(agentToken, "attach_integration", {
    agent: target,
    key: "notion",
    onBehalfOf: `@alice${sfx}`,
  });
  assert(twoOfHers.isError, "attach fails when the chosen person has several Notion workspaces");
  assert(
    twoOfHers.text.includes("Side project") && twoOfHers.text.includes("connectionId"),
    "the error names the accounts and points at connectionId",
  );

  const listed = await call(agentToken, "list_connections", { key: "notion" });
  assert(!listed.isError, "list_connections works");
  assert(
    listed.text.includes(aliceSide) && listed.text.includes(bobCrm) && listed.text.includes(`@alice${sfx}`),
    "list_connections shows each connection's id and owner, so connectionId is discoverable",
  );

  const byId = await call(agentToken, "attach_integration", {
    agent: target,
    key: "notion",
    config: { connectionId: aliceSide },
  });
  assert(!byId.isError, `an explicit connectionId picks one specific workspace (${byId.text})`);
  assert((await boundTo(targetId)) === aliceSide, "…and that is what gets bound");

  await detach(agentToken, target);
  const bogus = await call(agentToken, "attach_integration", {
    agent: target,
    key: "notion",
    config: { connectionId: "00000000-0000-0000-0000-000000000000" },
  });
  assert(bogus.isError, "a connectionId that belongs to nobody here is rejected");

  // -- create_agent: a failing integration must not strand a half-created agent --
  madeHandle = `made${sfx}`;
  const stranded = await call(agentToken, "create_agent", {
    handle: madeHandle,
    displayName: "Made By An Agent",
    integrations: [{ key: "notion", config: {} }],
  });
  assert(stranded.isError, "create_agent fails while the integration can't be resolved");
  const { rows: leftovers } = await pool.query(`select id from participants where workspace_id = $1 and handle = $2`, [
    wsId,
    madeHandle,
  ]);
  assert(leftovers.length === 0, "the failed create left no half-made agent behind");

  const made = await call(agentToken, "create_agent", {
    handle: madeHandle,
    displayName: "Made By An Agent",
    integrations: [{ key: "notion", config: {} }],
    onBehalfOf: `@bob${sfx}`,
  });
  assert(!made.isError, `create_agent attaches the integration when told whose account to use (${made.text})`);
  const madeId = made.text.match(/id ([0-9a-f-]{36})/)?.[1];
  assert((await boundTo(madeId)) === bobCrm, "the new agent is bound to the named person's connection");
  await call(agentToken, "delete_agent", { agent: `@${madeHandle}` });
  madeHandle = null;

  // -- humans are unchanged: own accounts only, and the picker still asks when they hold several --
  const humanMint = await post(`/api/tokens?participantId=${aliceId}`, { name: `attach e2e human ${sfx}` });
  humanTokenId = humanMint.id;
  const humanToken = humanMint.token;
  const hers = await call(humanToken, "attach_integration", { agent: target, key: "notion" });
  assert(
    hers.isError && hers.text.includes("choose which Notion account"),
    "a human with two Notion workspaces is still asked to choose",
  );
  const herPick = await call(humanToken, "attach_integration", {
    agent: target,
    key: "notion",
    config: { connectionId: aliceCrm },
  });
  assert(!herPick.isError, "…and binds the one she picks");
  assert((await boundTo(targetId)) === aliceCrm, "…to her own account");
  await detach(agentToken, target);
  const theirs = await call(humanToken, "attach_integration", {
    agent: target,
    key: "notion",
    config: { connectionId: bobCrm },
  });
  assert(theirs.isError, "a human cannot bind someone else's connection");

  pass = true;
} catch (e) {
  console.error("FAIL:", e.message ?? e);
} finally {
  try {
    if (madeHandle && wsId) {
      await pool.query(`delete from participants where workspace_id = $1 and handle = $2`, [wsId, madeHandle]);
    }
    for (const id of [tokenId, humanTokenId]) {
      if (id) await pool.query("delete from api_tokens where id = $1", [id]);
    }
    // participants cascade to their integration connections / agent integrations.
    if (wsId) {
      await pool.query("delete from participants where workspace_id = $1", [wsId]);
      await pool.query("delete from workspaces where id = $1", [wsId]);
    }
  } catch (e) {
    console.error("cleanup:", e.message);
  }
  await pool.end();
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
}
