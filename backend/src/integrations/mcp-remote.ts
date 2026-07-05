import type { ConfigureFrame } from "@jungle/shared";
import * as db from "../db";
import type { IntegrationAdapter } from "./types";
import { mcpConnection, getValidMcpToken, type McpProviderSpec } from "./mcp-oauth";

// Factory: build a full IntegrationAdapter for a remote MCP provider (Linear/Notion/Granola) from
// a spec. All three share the same shape — OAuth via mcp-oauth.ts, mounted by the runner as a
// remote MCP server — so adding one is just a spec + a register call. Per-agent state is split:
//   • agent_integrations row  → the integration is attached + its { requireApproval } toggle.
//   • integration_connections → the OAuth grant (created by the connect flow).
// A grant is emitted only when both exist and a token can be minted.

export interface McpAdapterSpec extends McpProviderSpec {
  // Read-only tool names auto-approved without a confirmation card, as bare tool names (the runner
  // prefixes mcp__<key>__). The rest route through the confirmation card when requireApproval is on.
  // Ignored when `readOnly` is set (all tools are safe).
  safeTools: string[];
  // A short phrase for the system prompt describing what this integration's tools do.
  toolsHint: string;
  // The provider exposes only read-only tools — nothing to approve. All tools run freely and the
  // approval toggle is irrelevant (see the catalog's readOnly flag for the UI side).
  readOnly?: boolean;
}

function requireApprovalOf(spec: McpAdapterSpec, config: Record<string, unknown>): boolean {
  if (spec.readOnly) return false; // read-only integration: nothing to approve
  return config.requireApproval !== false; // default on
}

function promptBlock(spec: McpAdapterSpec, requireApproval: boolean): string {
  if (spec.readOnly) {
    return (
      `\n\n— ${spec.displayName} —\n` +
      `You're connected to ${spec.displayName} through its MCP server; its tools appear as ` +
      `mcp__${spec.key}__* (${spec.toolsHint}). These are read-only. Only use them when you're ` +
      `actually asked to.`
    );
  }
  return (
    `\n\n— ${spec.displayName} —\n` +
    `You're connected to ${spec.displayName} through its MCP server; its tools appear as ` +
    `mcp__${spec.key}__* (${spec.toolsHint}). Reading and searching are always available; ` +
    (requireApproval
      ? `actions that create or change things require a human's approval, so you'll hit a ` +
        `confirmation prompt — tell the user when you're waiting on one. `
      : `changes run without a separate approval, so be careful. `) +
    `Only use these tools when you're actually asked to; never change ${spec.displayName} data as ` +
    `an incidental side effect.`
  );
}

export function createMcpRemoteAdapter(spec: McpAdapterSpec): IntegrationAdapter {
  return {
    key: spec.key,

    // Attach/reconfigure: the only per-agent config is the approval toggle (moot for read-only
    // integrations). The OAuth grant lives in integration_connections, set by the connect flow.
    async resolveConfig(_ctx, rawConfig): Promise<Record<string, unknown>> {
      if (spec.readOnly) return { requireApproval: false };
      return {
        requireApproval: rawConfig.requireApproval !== false && rawConfig.requireApproval !== "false",
      };
    },

    async buildGrant(frame: ConfigureFrame, agent, config): Promise<string | null> {
      const connected = await db.getIntegrationConnection(agent.id, spec.key);
      if (!connected) return null; // attached but not connected yet — advertise nothing
      let accessToken: string;
      try {
        accessToken = await getValidMcpToken(spec, agent.id);
      } catch (e) {
        console.error(`runner[${agent.id}] configure: could not mint ${spec.key} token:`, e);
        return null;
      }
      const requireApproval = requireApprovalOf(spec, config);
      (frame.mcpIntegrations ??= []).push({
        key: spec.key,
        url: spec.mcpUrl,
        accessToken,
        safeTools: spec.safeTools.map((t) => `mcp__${spec.key}__${t}`),
        requireApproval,
      });
      return promptBlock(spec, requireApproval);
    },

    async refreshCredentials(agent, _config, send): Promise<void> {
      const connected = await db.getIntegrationConnection(agent.id, spec.key);
      if (!connected) return;
      try {
        const accessToken = await getValidMcpToken(spec, agent.id);
        send({ type: "integration_credentials", key: spec.key, accessToken });
      } catch (e) {
        console.error(`runner[${agent.id}] could not refresh ${spec.key} token:`, e);
      }
    },

    connection: mcpConnection(spec),
  };
}
