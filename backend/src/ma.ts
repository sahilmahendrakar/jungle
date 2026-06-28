import "./env";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// IDs of the shared agent config + cloud environment, created by scripts/smoke.mjs.
const here = dirname(fileURLToPath(import.meta.url)); // backend/src
const idsPath = join(here, "../../.jungle-ids.json"); // jungle/.jungle-ids.json
const ids: { agentId: string; environmentId: string } = JSON.parse(readFileSync(idsPath, "utf8"));

const client = new Anthropic(); // ANTHROPIC_API_KEY from env (loaded by ./env)

// One MA session per agent participant — clean memory per agent.
export async function createAgentSession(title: string): Promise<string> {
  const session = await client.beta.sessions.create({
    agent: ids.agentId,
    environment_id: ids.environmentId,
    title,
  });
  return session.id;
}

// Run one turn: send input, stream until the turn is done, return the full reply text.
export async function runAgentTurn(sessionId: string, inputText: string): Promise<string> {
  const stream = await client.beta.sessions.events.stream(sessionId);
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text: inputText }] }],
  });

  let reply = "";
  for await (const event of stream as AsyncIterable<any>) {
    if (event.type === "agent.message") {
      for (const block of event.content) if (block.type === "text") reply += block.text;
    } else if (event.type === "session.status_idle") {
      if (event.stop_reason?.type !== "requires_action") break;
    } else if (event.type === "session.status_terminated") {
      break;
    }
  }
  return reply;
}
