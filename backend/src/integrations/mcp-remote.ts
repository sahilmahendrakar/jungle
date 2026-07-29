import type { ConfigureFrame } from "@jungle/shared";
import * as db from "../db";
import type { IntegrationAdapter } from "./types";
import { resolveConnection } from "./backing";
import { mcpConnection, getValidMcpToken, type McpProviderSpec } from "./mcp-oauth";

// Factory: build a full IntegrationAdapter for a remote MCP provider (Linear/Notion/Granola) from
// a spec. All three share the same shape — OAuth via mcp-oauth.ts, mounted by the runner as a
// remote MCP server — so adding one is just a spec + a register call. Like Gmail:
//   • The OAuth grant is PER-USER (integration_connections), connected once in Settings — a user
//     may hold several connections for the same provider (e.g. two Notion workspaces).
//   • Attaching to an agent stores config { connectionId, requireApproval? } — the agent acts with
//     that specific connection; a grant is emitted only when a token can be minted for it.

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

// Shown when the integration is attached but the backing connection is permanently dead
// (needs_reconnect) or gone — so the agent can name the problem instead of silently having no
// mcp__<key>__* tools (mirrors gmail.ts's disconnectedBlock).
function disconnectedBlock(spec: McpAdapterSpec): string {
  return (
    `\n\n— ${spec.displayName}: connection expired —\n` +
    `Your ${spec.displayName} integration is attached, but the backing authorization has expired ` +
    `or been revoked, so the mcp__${spec.key}__* tools are NOT available this session. Do NOT ` +
    `silently skip ${spec.displayName} work because of this. If the task at hand involves ` +
    `${spec.displayName}, tell the user: your ${spec.displayName} connection expired and needs to ` +
    `be reconnected in Settings → Connections — then you can pick the work back up.`
  );
}

export function createMcpRemoteAdapter(spec: McpAdapterSpec): IntegrationAdapter {
  return {
    key: spec.key,

    // Attach/reconfigure: binds the agent to one specific connection (config.connectionId) — the
    // picker's choice (rawConfig.connectionId) when given, else the existing binding on
    // reconfigure, else resolved from the attacher (backing.ts: the human's sole connection, or,
    // when an AGENT is attaching, the account of the person it's acting for). The only other
    // config is the approval toggle (moot for read-only integrations).
    async resolveConfig(ctx, rawConfig): Promise<Record<string, unknown>> {
      const requireApproval =
        !spec.readOnly && rawConfig.requireApproval !== false && rawConfig.requireApproval !== "false";
      const extra = spec.readOnly ? {} : { requireApproval };

      const requestedId = typeof rawConfig.connectionId === "string" ? rawConfig.connectionId : null;
      const existingId = typeof ctx.existing?.connectionId === "string" ? ctx.existing.connectionId : null;
      const conn = await resolveConnection(ctx, {
        key: spec.key,
        displayName: spec.displayName,
        requestedId: requestedId ?? existingId,
      });
      return { connectionId: conn.id, ...extra };
    },

    async buildGrant(frame: ConfigureFrame, agent, config): Promise<string | null> {
      const connectionId = typeof config.connectionId === "string" ? config.connectionId : null;
      if (!connectionId) return null; // not yet bound to a connection — advertise nothing
      let accessToken: string;
      try {
        accessToken = await getValidMcpToken(spec, connectionId);
      } catch (e) {
        console.error(`runner[${agent.id}] configure: could not mint ${spec.key} token:`, e);
        // Permanently dead (flagged needs_reconnect by getValidMcpToken) or disconnected
        // entirely → tell the agent so it can tell the user (mirrors gmail.ts). Transient
        // failures stay silent.
        const row = await db.getIntegrationConnectionById(connectionId).catch(() => null);
        if (!row || row.needs_reconnect) return disconnectedBlock(spec);
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

    async refreshCredentials(agent, config, send): Promise<void> {
      const connectionId = typeof config.connectionId === "string" ? config.connectionId : null;
      if (!connectionId) return;
      try {
        const accessToken = await getValidMcpToken(spec, connectionId);
        send({ type: "integration_credentials", key: spec.key, accessToken });
      } catch (e) {
        console.error(`runner[${agent.id}] could not refresh ${spec.key} token:`, e);
      }
    },

    connection: mcpConnection(spec),
  };
}
