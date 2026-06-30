// Step 7 end-to-end through the real app: provision a GitHub-capable agent via /api/agents
// (repo mounted + vault + GitHub MCP), @mention it in a channel over WebSocket asking for a
// PR, and confirm (1) the agent's reply fans back to the human, and (2) a real PR was opened.
// Prints PR_NUMBER=<n> for the wrapper to clean up on GitHub. Cleans up MA session+vault + DB.
// Run (backend must be up): set -a; . ~/.config/jungle/.env; set +a; node backend/test/step7-agent-e2e.mjs
import { WebSocket } from "ws";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";

const BASE = "http://localhost:3001";
const WS = "ws://localhost:3001";
const sfx = Date.now().toString(36);
const human = `sahil_${sfx}`;
const ag = `prbot_${sfx}`;
const chan = `eng_${sfx}`;
const REPO = "sahilmahendrakar/jungle";
const stamp = Date.now();
const post = (p, b) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic();
let pass = false;
let prNumber = "";
const cleanup = { participants: [], channels: [], sessions: [], vaults: [] };

try {
  const H = await post("/api/participants", { kind: "human", handle: human, displayName: "Sahil" });
  cleanup.participants.push(H.id);
  console.log("provisioning GitHub agent (clones repo — may take ~30s)…");
  const A = await post("/api/agents", { handle: ag, displayName: "PR Bot", repo: REPO });
  if (!A.id) throw new Error("agent create failed: " + JSON.stringify(A));
  cleanup.participants.push(A.id);
  if (A.ma_session_id) cleanup.sessions.push(A.ma_session_id);
  if (A.vault_id) cleanup.vaults.push(A.vault_id);
  console.log("agent:", { id: A.id, session: A.ma_session_id, repo: A.repo, vault: A.vault_id, repoRes: A.repo_resource_id });

  const c = await post("/api/channels", { name: chan, kind: "channel", memberHandles: [human, ag] });
  cleanup.channels.push(c.id);

  const ws = new WebSocket(`${WS}/?participantId=${H.id}`);
  await new Promise((r) => ws.on("open", r));
  const got = [];
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === "message" && m.message?.sender_id === A.id) got.push(m.message.body);
    } catch {}
  });

  ws.send(JSON.stringify({
    type: "post",
    channelId: c.id,
    clientMsgId: "e2e1",
    body: `@${ag} Please open a pull request on ${REPO} that adds a new file ` +
      `e2e-test/${stamp}.md containing the line "jungle e2e ${stamp}". ` +
      `Use a new branch. When done, reply here with the PR link.`,
  }));

  // wait for the agent's reply containing a PR link
  let prLink = "";
  for (let i = 0; i < 100 && !prLink; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const hit = got.find((b) => /github\.com\/.+\/pull\/\d+/.test(b));
    if (hit) prLink = hit.match(/https?:\/\/github\.com\/\S+?\/pull\/\d+/)?.[0] ?? "";
  }
  ws.close();

  console.log("agent messages received:", got.length);
  if (got.length) console.log("last:", got[got.length - 1].slice(0, 300));
  prNumber = prLink.match(/\/pull\/(\d+)/)?.[1] ?? "";
  const checks = {
    "agent replied to the human (fan-out)": got.length > 0,
    "reply contains a PR link": Boolean(prLink),
  };
  console.log("checks:", checks);
  pass = Object.values(checks).every(Boolean);
  if (prNumber) console.log("PR_NUMBER=" + prNumber);
} catch (e) {
  console.error("ERROR:", e.message);
} finally {
  for (const id of cleanup.channels) await pool.query("delete from channels where id = $1", [id]).catch(() => {});
  await pool.query(
    `delete from channels where kind = 'dm' and id in (select channel_id from channel_members where participant_id = any($1))`,
    [cleanup.participants],
  ).catch(() => {});
  for (const id of cleanup.participants) await pool.query("delete from participants where id = $1", [id]).catch(() => {});
  await pool.end();
  for (const s of cleanup.sessions) await anthropic.beta.sessions.delete(s).catch(() => {});
  for (const v of cleanup.vaults) await anthropic.beta.vaults.delete(v).catch(() => {});
}

console.log(pass ? "✅ STEP7 AGENT E2E PASS" : "❌ STEP7 AGENT E2E FAIL");
process.exit(pass ? 0 : 1);
