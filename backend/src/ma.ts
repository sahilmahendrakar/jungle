import "./env";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// IDs of the shared agent config + cloud environment, created by scripts/smoke.mjs.
const here = dirname(fileURLToPath(import.meta.url)); // backend/src
const idsPath = join(here, "../../.jungle-ids.json"); // jungle/.jungle-ids.json
const ids: { agentId: string; githubAgentId?: string; environmentId: string } = JSON.parse(
  readFileSync(idsPath, "utf8"),
);

const client = new Anthropic(); // ANTHROPIC_API_KEY from env (loaded by ./env)

export type AgentMode = "always_ask" | "always_allow";

// The custom send_message tool — the agent's ONLY channel to talk to Jungle. Must be listed
// in any per-session `tools` override (overrides replace the config's tools in full).
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

// Build the per-session `tools` override. permission_policy is what makes an agent
// always_ask (tool calls pause on requires_action) vs always_allow (run autonomously).
// send_message is a custom tool we always execute ourselves.
function toolsOverride(github: boolean, mode: AgentMode) {
  const permission_policy = { type: mode === "always_ask" ? "always_ask" : "always_allow" };
  const tools: unknown[] = [
    { type: "agent_toolset_20260401", default_config: { enabled: true, permission_policy } },
  ];
  if (github) {
    tools.push({
      type: "mcp_toolset",
      mcp_server_name: "github",
      default_config: { enabled: true, permission_policy },
    });
  }
  tools.push(SEND_TOOL);
  return tools;
}

// `agent_with_overrides`: reference the shared config by id but override model + tools for
// THIS session only (no new agent version). Lets each agent pick its own model + permission
// mode while all sessions share one config. mcp_servers/system are inherited (omitted).
// Cast: the installed SDK types don't yet include the overrides form.
function agentOverride(configId: string, github: boolean, model: string | null | undefined, mode: AgentMode) {
  return {
    type: "agent_with_overrides",
    id: configId,
    ...(model ? { model: { id: model } } : {}),
    tools: toolsOverride(github, mode),
  } as unknown as string;
}

// One MA session per agent participant — clean memory per agent. Per-agent model + permission
// mode are applied as per-session overrides on the shared config.
export async function createAgentSession(
  title: string,
  model?: string | null,
  mode: AgentMode = "always_allow",
): Promise<string> {
  const session = await client.beta.sessions.create({
    agent: agentOverride(ids.agentId, false, model, mode),
    environment_id: ids.environmentId,
    title,
  });
  return session.id;
}

// --- GitHub-capable agents: vault + repo-mounted session + token rotation (Step 7) ---

// Create a vault holding one static_bearer MCP credential. Returns the ids we persist so we
// can rotate the (short-lived) token later. Generic: caller supplies the MCP url + token.
export async function createMcpVault(
  label: string,
  mcpServerUrl: string,
  token: string,
): Promise<{ vaultId: string; credentialId: string }> {
  const vault = await client.beta.vaults.create({ display_name: label });
  const cred = await client.beta.vaults.credentials.create(vault.id, {
    display_name: `mcp ${mcpServerUrl}`,
    auth: { type: "static_bearer", mcp_server_url: mcpServerUrl, token },
  });
  return { vaultId: vault.id, credentialId: cred.id };
}

// Create a session on the GitHub-capable agent config, with the repo mounted and the vault
// attached. Returns the session id + the github_repository resource id (for token rotation).
export async function createRepoAgentSession(
  title: string,
  opts: { repoUrl: string; repoToken: string; vaultId: string },
  model?: string | null,
  mode: AgentMode = "always_allow",
): Promise<{ sessionId: string; repoResourceId: string }> {
  if (!ids.githubAgentId) throw new Error("githubAgentId not set — run scripts/setup-github-agent.mjs");
  const session = await client.beta.sessions.create({
    agent: agentOverride(ids.githubAgentId, true, model, mode),
    environment_id: ids.environmentId,
    title,
    vault_ids: [opts.vaultId],
    resources: [
      { type: "github_repository", url: opts.repoUrl, authorization_token: opts.repoToken },
    ],
  });
  const repoRes = (session.resources ?? []).find((r: any) => r.type === "github_repository");
  return { sessionId: session.id, repoResourceId: (repoRes as any)?.id ?? "" };
}

// Refresh the credentials a long-lived session uses, before a turn. Installation tokens last
// ~1h; this swaps in the current one for both git (repo resource) and the MCP vault credential.
export async function rotateRepoAuth(opts: {
  sessionId: string;
  repoResourceId: string;
  vaultId: string;
  credentialId: string;
  token: string;
}): Promise<void> {
  if (opts.repoResourceId) {
    await client.beta.sessions.resources.update(opts.repoResourceId, {
      session_id: opts.sessionId,
      authorization_token: opts.token,
    });
  }
  await client.beta.vaults.credentials.update(opts.credentialId, {
    vault_id: opts.vaultId,
    auth: { type: "static_bearer", token: opts.token },
  });
}

export type SendMessageInput = { to?: string; body?: string };
export type SendMessageResult = { ok: boolean; error?: string; messageId?: string };

// A built-in / MCP tool call the agent wants to run, awaiting an allow/deny decision.
export interface ToolConfirmRequest {
  toolUseId: string;
  name: string;
  input: unknown;
  sessionThreadId?: string | null;
}
export type ConfirmDecision = { result: "allow" | "deny"; denyMessage?: string };

export interface RunTurnCallbacks {
  // Handle a send_message custom-tool call (post into Jungle). Acked so the turn continues.
  onSend: (input: SendMessageInput) => Promise<SendMessageResult>;
  // Decide whether a built-in/MCP tool call may run (auto-allow, or ask a human).
  onConfirm: (req: ToolConfirmRequest) => Promise<ConfirmDecision>;
}

// Turns are serialized PER SESSION: two overlapping messages/cascades must never run
// concurrent streams on the same MA session, or they double-ack tool calls (duplicate
// messages) and collide on user.message ("waiting on responses" 400). This chains each
// turn after the previous one for that session.
const sessionQueues = new Map<string, Promise<unknown>>();

export function runAgentTurn(
  sessionId: string,
  inputText: string,
  cbs: RunTurnCallbacks,
): Promise<number> {
  const prev = sessionQueues.get(sessionId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => runAgentTurnInner(sessionId, inputText, cbs));
  sessionQueues.set(sessionId, next);
  void next.finally(() => {
    if (sessionQueues.get(sessionId) === next) sessionQueues.delete(sessionId);
  });
  return next;
}

// Run one turn. The agent talks via the `send_message` custom tool (handled by onSend);
// built-in/MCP tool calls under the `always_ask` policy pause on `requires_action` and are
// resolved via onConfirm -> user.tool_confirmation. Returns the count of messages sent.
async function runAgentTurnInner(
  sessionId: string,
  inputText: string,
  cbs: RunTurnCallbacks,
): Promise<number> {
  const stream = await client.beta.sessions.events.stream(sessionId);
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text: inputText }] }],
  });

  let sent = 0;
  const pendingTools = new Map<string, ToolConfirmRequest>(); // tool_use id -> request

  for await (const event of stream as AsyncIterable<any>) {
    if (event.type === "agent.custom_tool_use" && event.name === "send_message") {
      let result: SendMessageResult;
      try {
        result = await cbs.onSend((event.input ?? {}) as SendMessageInput);
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
    } else if (event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use") {
      // Remember it; we decide on the following requires_action.
      pendingTools.set(event.id, {
        toolUseId: event.id,
        name: event.name ?? event.tool_name ?? "tool",
        input: event.input ?? {},
        sessionThreadId: event.session_thread_id ?? null,
      });
    } else if (event.type === "session.status_idle") {
      const stop = event.stop_reason;
      if (stop?.type !== "requires_action") break; // end_turn / terminal
      for (const id of stop.event_ids ?? []) {
        const t = pendingTools.get(id);
        if (!t) continue; // custom-tool acks are handled inline above
        let decision: ConfirmDecision;
        try {
          decision = await cbs.onConfirm(t);
        } catch (e) {
          decision = { result: "deny", denyMessage: String((e as Error).message ?? e) };
        }
        await client.beta.sessions.events.send(sessionId, {
          events: [
            {
              type: "user.tool_confirmation",
              tool_use_id: id,
              result: decision.result,
              ...(decision.result === "deny" && decision.denyMessage
                ? { deny_message: decision.denyMessage }
                : {}),
              ...(t.sessionThreadId ? { session_thread_id: t.sessionThreadId } : {}),
            },
          ],
        });
        pendingTools.delete(id);
      }
    } else if (event.type === "session.status_terminated") {
      break;
    } else if (event.type === "session.error") {
      console.error("session.error:", JSON.stringify(event));
      break;
    }
  }
  return sent;
}
