// Agent-initiated attach of a connection-based integration (integrations/backing.ts).
//
// The bug this pins: an agent using the jungle-admin MCP tools (or an agent-bound API token) could
// never attach notion/gmail/linear/… — resolveConfig looked for a connection on the ACTOR, and an
// agent has no Settings page and never holds one, so it always failed with "connect your Notion
// account in Settings first" no matter how many times the human reconnected. Now the attach binds
// to the person the agent is acting for, and a failed attach during create_agent no longer strands
// a half-created agent.
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
let wsId, aliceId, bobId, archId, targetId, tokenId, madeHandle;

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

const addAgent = async (handle) =>
  (
    await pool.query(
      `insert into participants (kind, workspace_id, handle, display_name, runtime)
       values ('agent', $1, $2, $3, 'sdk') returning id`,
      [wsId, handle, handle],
    )
  ).rows[0].id;

// A stand-in for "this person connected Notion in Settings" — the tokens are never used here, only
// the row's existence is. Delete-then-insert rather than an upsert: this has to work whatever the
// table is keyed on.
async function connectNotion(participantId) {
  await pool.query(`delete from integration_connections where participant_id = $1 and integration_key = 'notion'`, [
    participantId,
  ]);
  await pool.query(
    `insert into integration_connections
       (participant_id, integration_key, external_account, access_token, refresh_token, extra)
     values ($1, 'notion', 'Notion · Test Workspace', 'fake-access', 'fake-refresh', '{}'::jsonb)`,
    [participantId],
  );
}

const backingOf = async (agentId) =>
  (
    await pool.query(`select config from agent_integrations where agent_id = $1 and integration_key = 'notion'`, [
      agentId,
    ])
  ).rows[0]?.config?.backingParticipantId ?? null;

try {
  // -- a throwaway workspace: alice (its creator) + bob, one acting agent, one target agent --
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
  archId = await addAgent(`arch${sfx}`);
  targetId = await addAgent(`target${sfx}`);

  const mint = await post(`/api/tokens?participantId=${aliceId}`, { name: `attach e2e ${sfx}`, participantId: archId });
  tokenId = mint.id;
  const agentToken = mint.token;
  assert(agentToken?.startsWith("jgl_"), "minted an agent-bound token for the acting agent");

  // -- nobody has connected Notion: a precise error, not "connect your Notion account" --
  const none = await call(agentToken, "attach_integration", { agent: `@target${sfx}`, key: "notion" });
  assert(none.isError, "attach fails while nobody in the workspace has connected Notion");
  assert(
    none.text.includes("nobody in this workspace has connected Notion") && !none.text.includes("connect your Notion"),
    "the error names the real problem instead of telling the agent to open Settings",
  );

  // -- one connected person: the attach binds to them --
  await connectNotion(aliceId);
  const one = await call(agentToken, "attach_integration", { agent: `@target${sfx}`, key: "notion" });
  assert(!one.isError, `agent attaches Notion once a person has connected it (${one.text})`);
  assert((await backingOf(targetId)) === aliceId, "it is backed by the connected person's account");

  // -- two connected people: ambiguous, so the caller must say who --
  await call(agentToken, "detach_integration", { agent: `@target${sfx}`, key: "notion" });
  await connectNotion(bobId);
  const many = await call(agentToken, "attach_integration", { agent: `@target${sfx}`, key: "notion" });
  assert(many.isError, "attach fails when several people have connected Notion");
  assert(
    many.text.includes(`@alice${sfx}`) && many.text.includes(`@bob${sfx}`) && many.text.includes("onBehalfOf"),
    "the error lists the candidates and how to choose one",
  );

  const named = await call(agentToken, "attach_integration", {
    agent: `@target${sfx}`,
    key: "notion",
    onBehalfOf: `@bob${sfx}`,
  });
  assert(!named.isError, `onBehalfOf resolves the ambiguity (${named.text})`);
  assert((await backingOf(targetId)) === bobId, "it is backed by the named person's account");

  const asAgent = await call(agentToken, "attach_integration", {
    agent: `@target${sfx}`,
    key: "notion",
    onBehalfOf: `@arch${sfx}`,
  });
  assert(asAgent.isError && asAgent.text.includes("must be a person"), "onBehalfOf rejects an agent");

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
    onBehalfOf: `@alice${sfx}`,
  });
  assert(!made.isError, `create_agent attaches the integration when told whose account to use (${made.text})`);
  const madeId = made.text.match(/id ([0-9a-f-]{36})/)?.[1];
  assert((await backingOf(madeId)) === aliceId, "the new agent's Notion is backed by the named person");
  await call(agentToken, "delete_agent", { agent: `@${madeHandle}` });
  madeHandle = null;

  // -- a human still binds their own account, and can't borrow someone else's --
  const humanMint = await post(`/api/tokens?participantId=${aliceId}`, { name: `attach e2e human ${sfx}` });
  const humanToken = humanMint.token;
  await call(agentToken, "detach_integration", { agent: `@target${sfx}`, key: "notion" });
  const mine = await call(humanToken, "attach_integration", { agent: `@target${sfx}`, key: "notion" });
  assert(!mine.isError, "a human attaching Notion still binds their own connection");
  assert((await backingOf(targetId)) === aliceId, "…to their own account");
  await call(agentToken, "detach_integration", { agent: `@target${sfx}`, key: "notion" });
  const theirs = await call(humanToken, "attach_integration", {
    agent: `@target${sfx}`,
    key: "notion",
    onBehalfOf: `@bob${sfx}`,
  });
  assert(theirs.isError && theirs.text.includes("your own connected accounts"), "a human can't bind someone else's");
  await pool.query(`delete from api_tokens where id = $1`, [humanMint.id]);

  pass = true;
} catch (e) {
  console.error("FAIL:", e.message ?? e);
} finally {
  try {
    if (madeHandle && wsId) {
      await pool.query(`delete from participants where workspace_id = $1 and handle = $2`, [wsId, madeHandle]);
    }
    if (tokenId) await pool.query("delete from api_tokens where id = $1", [tokenId]);
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
