import type { ConfigureFrame } from "@jungle/shared";
import * as db from "../db";
import { ApiError } from "../http/errors";
import type { IntegrationAdapter } from "./types";
import { mcpConnection, getValidMcpToken, type McpProviderSpec } from "./mcp-oauth";

// Factory: build a full IntegrationAdapter for a remote MCP provider (Linear/Notion/Granola) from
// a spec. All three share the same shape — OAuth via mcp-oauth.ts, mounted by the runner as a
// remote MCP server — so adding one is just a spec + a register call. Like Gmail:
//   • The OAuth grant is PER-USER (integration_connections), connected once in Settings.
//   • Attaching to an agent stores config { backingParticipantId, requireApproval? } — the agent
//     acts with that user's connection; a grant is emitted only when a token can be minted for it.

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

    // Attach/reconfigure: binds the agent to the attaching user's connection (backingParticipantId),
    // like gmail — 400 if they haven't connected in Settings. A reconfigure keeps the original
    // backing user. The only other config is the approval toggle (moot for read-only integrations).
    async resolveConfig(ctx, rawConfig): Promise<Record<string, unknown>> {
      const requireApproval =
        !spec.readOnly && rawConfig.requireApproval !== false && rawConfig.requireApproval !== "false";
      const existingBacking =
        typeof ctx.existing?.backingParticipantId === "string" ? ctx.existing.backingParticipantId : null;
      const backingParticipantId = existingBacking ?? ctx.me.id;
      if (!existingBacking) {
        const conn = await db.getIntegrationConnection(ctx.me.id, spec.key);
        if (!conn) throw new ApiError(400, `connect your ${spec.displayName} account in Settings first`);
      }
      return spec.readOnly ? { backingParticipantId } : { backingParticipantId, requireApproval };
    },

    async buildGrant(frame: ConfigureFrame, agent, config): Promise<string | null> {
      const backing = typeof config.backingParticipantId === "string" ? config.backingParticipantId : null;
      if (!backing) return null; // not yet bound to a connected user — advertise nothing
      let accessToken: string;
      try {
        accessToken = await getValidMcpToken(spec, backing);
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

    async refreshCredentials(agent, config, send): Promise<void> {
      const backing = typeof config.backingParticipantId === "string" ? config.backingParticipantId : null;
      if (!backing) return;
      try {
        const accessToken = await getValidMcpToken(spec, backing);
        send({ type: "integration_credentials", key: spec.key, accessToken });
      } catch (e) {
        console.error(`runner[${agent.id}] could not refresh ${spec.key} token:`, e);
      }
    },

    connection: mcpConnection(spec),
  };
}
