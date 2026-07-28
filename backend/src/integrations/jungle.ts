import type { ConfigureFrame } from "@jungle/shared";
import * as db from "../db";
import { runnerHttpBaseFor } from "../provisioner";
import { SAFE_JUNGLE_TOOLS } from "../mcp/tools";
import type { IntegrationAdapter } from "./types";

// The "jungle-admin" integration: Jungle itself, mounted into an agent as a remote MCP server.
// Unlike every other integration there is no external account — the backend mints an API token
// bound to THE AGENT (db/apiTokens.ts) and points the runner at its own /mcp endpoint
// (mcp/server.ts), so the agent can do what workspace members do: create channels and agents,
// build/run workflows, manage schedules. The token is rotated on every configure (delete by name
// + recreate) so no plaintext is ever stored, and onDetach revokes it outright.
//
// The key is "jungle-admin", not "jungle": the runner's in-process chat server already owns the
// "jungle" MCP server name, and mcpServers is keyed by integration key (runner/src/runner.ts).

const KEY = "jungle-admin";
const TOKEN_NAME = "jungle integration";

function promptBlock(requireApproval: boolean): string {
  return (
    `\n\n— Jungle workspace management —\n` +
    `You can manage this Jungle workspace itself through the mcp__${KEY}__* tools: create ` +
    `channels and agents, add/remove channel members, build and run workflows, and manage ` +
    `schedules. Listing/reading tools are always available; ` +
    (requireApproval
      ? `tools that change the workspace require a human's approval, so you'll hit a ` +
        `confirmation prompt — tell the user when you're waiting on one. `
      : `changes run without a separate approval, so be careful — several of these tools ` +
        `(delete_agent especially) are destructive. `) +
    `For ordinary conversation keep using your built-in send_message/read_history/schedule_* ` +
    `tools; the mcp__${KEY}__* duplicates of those exist for external callers. Only reshape ` +
    `the workspace when you're actually asked to.`
  );
}

export const jungleAdapter: IntegrationAdapter = {
  key: KEY,

  // The only config is the approval toggle (default on).
  async resolveConfig(_ctx, rawConfig): Promise<Record<string, unknown>> {
    const requireApproval = rawConfig.requireApproval !== false && rawConfig.requireApproval !== "false";
    return { requireApproval };
  },

  async buildGrant(frame: ConfigureFrame, agent, config): Promise<string | null> {
    // Rotate rather than persist: a fresh token per configure means no plaintext at rest and a
    // bounded lifetime (each reconnect invalidates the last one).
    await db.deleteApiTokensByName(agent.id, TOKEN_NAME);
    const { token } = await db.createApiToken({ participantId: agent.id, name: TOKEN_NAME });
    const requireApproval = config.requireApproval !== false && config.requireApproval !== "false";
    (frame.mcpIntegrations ??= []).push({
      key: KEY,
      url: `${runnerHttpBaseFor(agent)}/mcp`,
      accessToken: token,
      safeTools: SAFE_JUNGLE_TOOLS.map((t) => `mcp__${KEY}__${t}`),
      requireApproval,
    });
    return promptBlock(requireApproval);
  },

  // Detach = revoke: the agent's token dies with the integration.
  async onDetach(agent): Promise<void> {
    await db.deleteApiTokensByName(agent.id, TOKEN_NAME);
  },
};
