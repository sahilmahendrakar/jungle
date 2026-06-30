// Step 0 smoke test: prove the Managed Agents path end-to-end, in isolation.
// Creates (once, cached) a cloud environment + a shared agent config, then opens a
// session, sends one message, and streams the reply. PASS = non-empty streamed reply.
//
// Run:  set -a; . .env; set +a; node scripts/smoke.mjs
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";

const IDS_PATH = new URL("../.jungle-ids.json", import.meta.url);
const MODEL = "claude-opus-4-8";
const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const loadIds = () => {
  try { return JSON.parse(readFileSync(IDS_PATH, "utf8")); } catch { return {}; }
};
const saveIds = (ids) => writeFileSync(IDS_PATH, JSON.stringify(ids, null, 2) + "\n");

const ids = loadIds();

// 1. Cloud environment (create once, reuse)
if (!ids.environmentId) {
  const env = await client.beta.environments.create({
    name: `jungle-mvp-${Date.now()}`,
    config: { type: "cloud", networking: { type: "unrestricted" } },
  });
  ids.environmentId = env.id;
  saveIds(ids);
  console.log("created environment:", env.id);
} else {
  console.log("reusing environment:", ids.environmentId);
}

// 2. Shared agent config (create once, reuse)
if (!ids.agentId) {
  const agent = await client.beta.agents.create({
    name: "Jungle Agent",
    model: MODEL,
    system: "You are a helpful agent in a Slack-like app called Jungle. Keep replies short.",
    tools: [{ type: "agent_toolset_20260401" }],
  });
  ids.agentId = agent.id;
  saveIds(ids);
  console.log("created agent config:", agent.id);
} else {
  console.log("reusing agent config:", ids.agentId);
}

// 3. Session
const session = await client.beta.sessions.create({
  agent: ids.agentId,
  environment_id: ids.environmentId,
  title: "step 0 smoke test",
});
console.log("session:", session.id);
console.log("watch:   https://platform.claude.com/workspaces/default/sessions/" + session.id);

// 4. Stream-first, then send.
const stream = await client.beta.sessions.events.stream(session.id);
await client.beta.sessions.events.send(session.id, {
  events: [{ type: "user.message", content: [{ type: "text", text: "Introduce yourself in one short sentence." }] }],
});

let reply = "";
process.stdout.write("\n--- agent reply ---\n");
for await (const event of stream) {
  if (event.type === "agent.message") {
    for (const block of event.content) {
      if (block.type === "text") { reply += block.text; process.stdout.write(block.text); }
    }
  } else if (event.type === "session.status_idle") {
    if (event.stop_reason?.type !== "requires_action") break;
  } else if (event.type === "session.status_terminated") {
    break;
  } else if (event.type === "session.error") {
    console.error("\nsession.error:", JSON.stringify(event));
    break;
  }
}
process.stdout.write("\n-------------------\n");

if (reply.trim().length > 0) {
  console.log("✅ STEP 0 PASS — streamed a non-empty reply");
  process.exit(0);
} else {
  console.error("❌ STEP 0 FAIL — no reply text received");
  process.exit(1);
}
