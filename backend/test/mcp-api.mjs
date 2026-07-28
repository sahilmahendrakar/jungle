// API-token + /mcp server verification: mints a participant-scoped token (dev-bypass mint), then
// drives the REST API and the MCP endpoint with it — channels, messaging, history, agent + agent
// integration management, workflow drafts, schedules, an agent-bound token, and revocation.
// Exit 0 = PASS. Self-cleaning: deletes the rows it created.
//
// Run:  set -a; . .env; set +a; node backend/test/mcp-api.mjs
//       BASE=http://localhost:3101 node backend/test/mcp-api.mjs   (against a non-default port)
import pg from "pg";

const BASE = process.env.BASE ?? "http://localhost:3001";
const sfx = Date.now().toString(36);
const humanHandle = `mcp_h_${sfx}`;
const agentHandle = `mcp_a_${sfx}`;
const chanName = `mcp_c_${sfx}`;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let pass = false;
let humanId, agentId, channelId, humanTokenId, agentTokenId;

const post = (path, body) =>
  fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

let rpcId = 0;
async function mcp(token, method, params, { expectStatus = 200 } = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (res.status !== expectStatus) {
    throw new Error(`${method}: expected HTTP ${expectStatus}, got ${res.status}: ${await res.text()}`);
  }
  if (expectStatus !== 200) return null;
  const body = await res.json();
  if (body.error) throw new Error(`${method}: rpc error ${JSON.stringify(body.error)}`);
  return body.result;
}

async function call(token, name, args = {}) {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`tool ${name} failed: ${text}`);
  return text;
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
  console.log(`ok: ${msg}`);
};

try {
  // -- setup: a dev-bypass human + their API token --
  const h = await post("/api/participants", { kind: "human", handle: humanHandle, displayName: "MCP Tester" });
  humanId = h.id;
  assert(humanId, "created dev human participant");

  const mint = await post(`/api/tokens?participantId=${humanId}`, { name: "e2e test" });
  humanTokenId = mint.id;
  const token = mint.token;
  assert(token?.startsWith("jgl_"), "minted a jgl_ token for the human");

  // -- token-authed REST: the whole existing API is now open to programmatic callers --
  const restChannels = await fetch(`${BASE}/api/channels`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert(restChannels.status === 200, "token-authed REST GET /api/channels works");

  // -- MCP handshake --
  const init = await mcp(token, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  assert(init.serverInfo?.name === "jungle", "initialize returns jungle serverInfo");
  assert(init.instructions.includes(`@${humanHandle}`), "initialize instructions carry the actor identity");

  const tools = (await mcp(token, "tools/list")).tools;
  for (const t of ["send_message", "create_channel", "create_agent", "workflow_finalize", "schedule_create"]) {
    assert(tools.some((x) => x.name === t), `tools/list includes ${t}`);
  }

  // -- channels + messaging --
  const created = await call(token, "create_channel", { name: chanName });
  channelId = created.match(/id ([0-9a-f-]{36})/)?.[1];
  assert(channelId, "create_channel returns the new channel id");
  assert((await call(token, "list_channels")).includes(`#${chanName}`), "list_channels shows it");

  const sent = await call(token, "send_message", { to: `#${chanName}`, body: "hello from the MCP e2e" });
  assert(/id [0-9a-f-]{36}/.test(sent), "send_message posts");
  const hist = await call(token, "read_history", { to: `#${chanName}` });
  assert(hist.includes("hello from the MCP e2e"), "read_history reads it back");

  // -- agent lifecycle --
  const agentOut = await call(token, "create_agent", {
    handle: agentHandle,
    displayName: "MCP Agent",
    persona: "You are a test agent.",
  });
  agentId = agentOut.match(/id ([0-9a-f-]{36})/)?.[1];
  assert(agentId, "create_agent returns the agent id");
  await call(token, "update_agent", { agent: `@${agentHandle}`, displayName: "MCP Agent v2" });
  await call(token, "attach_integration", { agent: `@${agentHandle}`, key: "jungle-admin", config: {} });
  const got = await call(token, "get_agent", { agent: `@${agentHandle}` });
  assert(got.includes("MCP Agent v2"), "update_agent applied");
  assert(got.includes("jungle-admin"), "attach_integration (jungle-admin) applied");

  // -- schedules --
  const sched = await call(token, "schedule_create", {
    agent: `@${agentHandle}`,
    channel: `#${chanName}`,
    prompt: "Post a haiku in #" + chanName,
    cron: "0 9 * * 1",
    timezone: "America/Los_Angeles",
  });
  const schedId = sched.match(/id ([0-9a-f-]{36})/)?.[1];
  assert(schedId, "schedule_create returns an id");
  assert((await call(token, "schedule_list")).includes(schedId), "schedule_list shows it");
  await call(token, "schedule_cancel", { scheduleId: schedId });

  // -- workflow drafts --
  const draftOut = await call(token, "workflow_draft_create", { name: `mcp wf ${sfx}` });
  const draftId = draftOut.match(/draftId: ([0-9a-f-]{36})/)?.[1];
  assert(draftId, "workflow_draft_create returns a draftId");
  assert((await call(token, "workflow_draft_get", { draftId })).includes(`mcp wf ${sfx}`), "workflow_draft_get reads it");
  assert((await call(token, "list_workflows")).includes(draftId), "list_workflows shows the draft");
  await pool.query("delete from workflows where id = $1", [draftId]);

  // -- an AGENT-bound token acts as the agent --
  await call(token, "add_channel_member", { channel: `#${chanName}`, handle: `@${agentHandle}` });
  const agentMint = await post(`/api/tokens?participantId=${humanId}`, {
    name: "e2e agent token",
    participantId: agentId,
  });
  agentTokenId = agentMint.id;
  assert(agentMint.token?.startsWith("jgl_"), "minted an agent-bound token");
  await call(agentMint.token, "send_message", { to: `#${chanName}`, body: "the agent speaks" });
  const { rows: senders } = await pool.query(
    "select sender_id from messages where channel_id = $1 order by seq desc limit 1",
    [channelId],
  );
  assert(senders[0]?.sender_id === agentId, "agent-token message is attributed to the agent");

  // -- revocation --
  const del = await fetch(`${BASE}/api/tokens/${agentTokenId}?participantId=${humanId}`, { method: "DELETE" });
  assert(del.status === 200, "token revoked");
  agentTokenId = null;
  await mcp(agentMint.token, "tools/list", undefined, { expectStatus: 401 });
  console.log("ok: revoked token is rejected with 401");
  await mcp("jgl_not_a_real_token", "tools/list", undefined, { expectStatus: 401 });
  console.log("ok: bogus token is rejected with 401");

  // -- cleanup through the tools themselves --
  await call(token, "delete_agent", { agent: `@${agentHandle}` });
  agentId = null;
  pass = true;
} catch (e) {
  console.error("FAIL:", e.message ?? e);
} finally {
  try {
    if (agentId) await pool.query("delete from participants where id = $1", [agentId]);
    if (channelId) await pool.query("delete from channels where id = $1", [channelId]);
    if (humanTokenId) await pool.query("delete from api_tokens where id = $1", [humanTokenId]);
    if (agentTokenId) await pool.query("delete from api_tokens where id = $1", [agentTokenId]);
    if (humanId) await pool.query("delete from participants where id = $1", [humanId]);
  } catch (e) {
    console.error("cleanup:", e.message);
  }
  await pool.end();
  console.log(pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
}
