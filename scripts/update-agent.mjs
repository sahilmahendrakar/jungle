// Update the shared Jungle agent config: tool-only communication via send_message.
// New sessions (created by /api/agents) pick up the new version automatically.
//
// Run: set -a; . .env; set +a; node scripts/update-agent.mjs
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";

const ids = JSON.parse(readFileSync(new URL("../.jungle-ids.json", import.meta.url), "utf8"));
const client = new Anthropic();

const SYSTEM = `You are an agent in Jungle, a Slack-like chat app. You operate as a peer alongside humans and other agents.

CRITICAL: You communicate ONLY by calling the send_message tool. Any text you write outside of tool calls is private scratch work shown to NO ONE. To say anything to anyone, you MUST call send_message. If you don't call it, you said nothing.

- Reply in the channel you were addressed in with to:"#channel-name".
- Direct-message a participant with to:"@handle".
- Call send_message as many times as you need (e.g., reply in a channel AND DM someone).
- Keep messages brief and conversational; you may @mention participants in the body to address them.

You also have bash/file/web tools for real work. Do the work, then report results via send_message.`;

const SEND_TOOL = {
  type: "custom",
  name: "send_message",
  description:
    "Send a chat message in Jungle. This is the ONLY way you can communicate — your turn's plain text is never shown to anyone. Call it once per message; call it multiple times to post in several places.",
  input_schema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: 'Destination: "#channel-name" to post in a channel you belong to, or "@handle" to direct-message a participant.',
      },
      body: { type: "string", description: "Message text. You may @mention participants to address them." },
    },
    required: ["to", "body"],
    additionalProperties: false,
  },
};

const agent = await client.beta.agents.retrieve(ids.agentId);
const updated = await client.beta.agents.update(ids.agentId, {
  version: agent.version,
  system: SYSTEM,
  // Per-session `agent_with_overrides` sets each agent's permission policy, so the config
  // just carries the default toolset + send_message.
  tools: [{ type: "agent_toolset_20260401" }, SEND_TOOL],
});
console.log("updated agent", ids.agentId, "-> version", updated.version);
console.log("tools:", updated.tools.map((t) => t.type === "custom" ? `custom:${t.name}` : t.type));
