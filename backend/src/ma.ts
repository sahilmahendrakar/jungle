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

export type SendMessageInput = { to?: string; body?: string };
export type SendMessageResult = { ok: boolean; error?: string; messageId?: string };

// Run one turn. The agent communicates ONLY via the `send_message` custom tool: each call
// is handled by `onSend` (which posts into Jungle) and acked so the turn continues. The
// agent's plain text output is intentionally ignored. Returns the count of messages sent.
export async function runAgentTurn(
  sessionId: string,
  inputText: string,
  onSend: (input: SendMessageInput) => Promise<SendMessageResult>,
): Promise<number> {
  const stream = await client.beta.sessions.events.stream(sessionId);
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text: inputText }] }],
  });

  let sent = 0;
  for await (const event of stream as AsyncIterable<any>) {
    if (event.type === "agent.custom_tool_use" && event.name === "send_message") {
      let result: SendMessageResult;
      try {
        result = await onSend((event.input ?? {}) as SendMessageInput);
      } catch (e) {
        result = { ok: false, error: String((e as Error).message ?? e) };
      }
      if (result.ok) sent++;
      await client.beta.sessions.events.send(sessionId, {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            content: [{ type: "text", text: JSON.stringify(result) }],
          },
        ],
      });
    } else if (event.type === "session.status_idle") {
      if (event.stop_reason?.type !== "requires_action") break; // terminal turn end
    } else if (event.type === "session.status_terminated") {
      break;
    } else if (event.type === "session.error") {
      console.error("session.error:", JSON.stringify(event));
      break;
    }
  }
  return sent;
}
