import type { ConfigureFrame } from "@jungle/shared";
import * as db from "../db";
import { ApiError } from "../http/errors";
import type { IntegrationAdapter } from "./types";

// Remote-MCP integrations authenticated with a STATIC pasted credential instead of OAuth —
// analytics tools whose official hosted MCP servers take a long-lived key (PostHog personal API
// key, Mixpanel service account). Same runtime shape as mcp-remote.ts (frame.mcpIntegrations
// entry with url + bearer value), but the connection lifecycle is "validate + store the pasted
// key" (validateAndStore, called from routes/liana.ts) rather than an OAuth round-trip.
// The connection row stores the ready-to-use bearer VALUE in access_token (the runner sends
// `Authorization: Bearer <accessToken>`; Mixpanel's "Bearer Basic <b64>" fits that shape by
// storing "Basic <b64>").

export interface StaticMcpSpec {
  key: string;
  displayName: string;
  toolsHint: string;
  // MCP endpoint for a given connection (Mixpanel varies by data-residency region, recorded in
  // the connection row's extra at validate time).
  mcpUrlFor(extra: Record<string, unknown>): string;
  // Validate pasted credentials against the provider; return the stored shape or throw
  // ApiError(400) with a human explanation. `fields` comes straight from the web form.
  validate(fields: Record<string, string>): Promise<{
    bearerValue: string;
    externalAccount: string | null;
    extra: Record<string, unknown>;
  }>;
}

function promptBlock(spec: StaticMcpSpec): string {
  return (
    `\n\n— ${spec.displayName} —\n` +
    `You're connected to ${spec.displayName} through its MCP server; its tools appear as ` +
    `mcp__${spec.key}__* (${spec.toolsHint}). Treat this as READ-ONLY: query and summarize, but ` +
    `never create, edit or delete anything (dashboards, flags, definitions) unless the user ` +
    `explicitly asked for that exact change. Only use these tools when the task calls for it.`
  );
}

function disconnectedBlock(spec: StaticMcpSpec): string {
  return (
    `\n\n— ${spec.displayName}: not connected —\n` +
    `Your ${spec.displayName} integration is attached but its credential is missing or was ` +
    `removed, so the mcp__${spec.key}__* tools are NOT available this session. Do NOT silently ` +
    `skip ${spec.displayName} work — tell the user to reconnect it in Settings → Connections.`
  );
}

export function createStaticMcpAdapter(spec: StaticMcpSpec): IntegrationAdapter & {
  validateAndStore(me: db.Participant, fields: Record<string, string>): Promise<void>;
} {
  return {
    key: spec.key,

    // Attach: binds to the attaching user's stored credential (same backing pattern as
    // mcp-remote.ts); 400 when they haven't pasted a key yet.
    async resolveConfig(ctx): Promise<Record<string, unknown>> {
      const existingBacking =
        typeof ctx.existing?.backingParticipantId === "string" ? ctx.existing.backingParticipantId : null;
      const backingParticipantId = existingBacking ?? ctx.me.id;
      if (!existingBacking) {
        const conn = await db.getIntegrationConnection(ctx.me.id, spec.key);
        if (!conn) throw new ApiError(400, `connect your ${spec.displayName} account first`);
      }
      return { backingParticipantId };
    },

    async buildGrant(frame: ConfigureFrame, agent, config): Promise<string | null> {
      const backing = typeof config.backingParticipantId === "string" ? config.backingParticipantId : null;
      if (!backing) return null;
      const conn = await db.getIntegrationConnection(backing, spec.key);
      if (!conn) return disconnectedBlock(spec);
      (frame.mcpIntegrations ??= []).push({
        key: spec.key,
        url: spec.mcpUrlFor(conn.extra ?? {}),
        accessToken: conn.access_token,
        safeTools: [], // moot: requireApproval false (read-only-by-instruction analytics)
        requireApproval: false,
      });
      return promptBlock(spec);
    },

    async refreshCredentials(agent, config, send): Promise<void> {
      // Static credential — nothing to re-mint; re-send so a long-lived runner that dropped it
      // gets the same value back.
      const backing = typeof config.backingParticipantId === "string" ? config.backingParticipantId : null;
      if (!backing) return;
      const conn = await db.getIntegrationConnection(backing, spec.key);
      if (conn) send({ type: "integration_credentials", key: spec.key, accessToken: conn.access_token });
    },

    // The paste-key "connect" (routes/liana.ts POST /api/liana/connections/:key/apikey).
    async validateAndStore(me: db.Participant, fields: Record<string, string>): Promise<void> {
      const result = await spec.validate(fields);
      await db.upsertIntegrationConnection({
        participantId: me.id,
        key: spec.key,
        externalAccount: result.externalAccount,
        accessToken: result.bearerValue,
        refreshToken: null,
        accessExpiresAt: null,
        scopes: null,
        extra: result.extra,
      });
    },
  };
}
