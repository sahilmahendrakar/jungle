// Create/update the GitHub-capable agent config: base toolset + send_message + the hosted
// GitHub MCP server (PRs/commits/issues). Sessions using it mount a github_repository and
// attach a vault with the GitHub credential. ID stored as githubAgentId in .jungle-ids.json.
//
// Run: set -a; . .env; set +a; node scripts/setup-github-agent.mjs
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";

const IDS_PATH = new URL("../.jungle-ids.json", import.meta.url);
const ids = JSON.parse(readFileSync(IDS_PATH, "utf8"));
const client = new Anthropic();

const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

const SYSTEM = `You are an agent in Jungle, a Slack-like chat app, operating as a peer alongside humans and other agents. You are also a capable software engineer with a real cloud workspace.

COMMUNICATION: You talk to people ONLY by calling the send_message tool. Text you write outside tool calls is private scratch work shown to NO ONE. To say anything, call send_message (to:"#channel-name" to post in a channel, to:"@handle" to DM). Call it as many times as needed. Keep messages brief and conversational.

GITHUB WORK: When a repository is mounted, it lives at /workspace/<repo>. Use bash + git for code (branch, edit, commit, push — git is pre-authenticated). Use the GitHub MCP tools for anything that goes through the GitHub API: opening pull requests, reading commits/diffs, issues, reviews. Do real work first, then report results (with the PR/commit URL) via send_message.`;

const SEND_TOOL = {
  type: "custom",
  name: "send_message",
  description:
    "Send a chat message in Jungle. This is the ONLY way you can communicate — your turn's plain text is never shown to anyone. Call once per message; call multiple times to post in several places.",
  input_schema: {
    type: "object",
    properties: {
      to: { type: "string", description: 'Destination: "#channel-name" or "@handle".' },
      body: { type: "string", description: "Message text. You may @mention participants." },
    },
    required: ["to", "body"],
    additionalProperties: false,
  },
};

const config = {
  name: "Jungle GitHub Agent",
  model: "claude-opus-4-8",
  system: SYSTEM,
  mcp_servers: [{ type: "url", name: "github", url: GITHUB_MCP_URL }],
  // Default policy on the shared config. Per-session `agent_with_overrides` sets the actual
  // permission policy for each agent (always_allow vs always_ask), so this is just a baseline.
  tools: [
    {
      type: "agent_toolset_20260401",
      default_config: { enabled: true, permission_policy: { type: "always_allow" } },
    },
    {
      type: "mcp_toolset",
      mcp_server_name: "github",
      default_config: { enabled: true, permission_policy: { type: "always_allow" } },
    },
    SEND_TOOL,
  ],
};

let id = ids.githubAgentId;
if (!id) {
  const agent = await client.beta.agents.create(config);
  id = agent.id;
  ids.githubAgentId = id;
  writeFileSync(IDS_PATH, JSON.stringify(ids, null, 2) + "\n");
  console.log("created github agent config:", id);
} else {
  const cur = await client.beta.agents.retrieve(id);
  const updated = await client.beta.agents.update(id, { version: cur.version, ...config });
  console.log("updated github agent config:", id, "-> version", updated.version);
}
const final = await client.beta.agents.retrieve(id);
console.log("tools:", final.tools.map((t) => (t.type === "custom" ? `custom:${t.name}` : t.type)));
console.log("mcp_servers:", JSON.stringify(final.mcp_servers));
