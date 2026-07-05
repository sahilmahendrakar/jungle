import type { ConfigureFrame } from "@jungle/shared";
import * as db from "../db";
import * as google from "../google";
import type { IntegrationAdapter } from "./types";

// Google Drive integration: the agent can search, read, and (with approval) create/update files in
// a connected Drive via the runner's in-process drive_* MCP tools — structurally like Gmail, but
// the OAuth grant is PER-AGENT (integration_connections) rather than a per-user identity. Uses the
// same Google OAuth client as Gmail (google.ts); the connect flow requests DRIVE_SCOPES.

const KEY = "google-drive";

function requireApprovalOf(config: Record<string, unknown>): boolean {
  return config.requireApproval !== false; // default on
}

// A valid access token for the agent's Drive connection, refreshing from the stored refresh token
// if near expiry (mirrors google.ts:getValidGmailToken but reads/writes integration_connections).
async function getValidDriveToken(agentId: string): Promise<string> {
  const row = await db.getIntegrationConnection(agentId, KEY);
  if (!row) throw new Error(`agent ${agentId} has no Google Drive connection`);
  const exp = row.access_expires_at ? new Date(row.access_expires_at).getTime() : Infinity;
  if (exp - Date.now() > 60_000) return row.access_token;
  if (!row.refresh_token) throw new Error("Drive token expired and no refresh token; reconnect");
  const tok = await google.googleRefreshToken(row.refresh_token);
  await db.updateIntegrationTokens({
    agentId,
    key: KEY,
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken ?? row.refresh_token,
    accessExpiresAt: tok.accessExpiresAt,
  });
  return tok.accessToken;
}

function promptBlock(email: string, requireApproval: boolean): string {
  return (
    `\n\n— Google Drive: ${email} —\n` +
    `You can act on this Drive with the drive_* tools: drive_search (find files by query), ` +
    `drive_list (list a folder), drive_get_file (read a file's contents, exporting Google Docs/` +
    `Sheets/Slides to text), drive_create_file (create a file), drive_update_file (overwrite a ` +
    `file). Searching and reading are always available; ` +
    (requireApproval
      ? `creating and updating require a human's approval, so you'll hit a confirmation prompt — ` +
        `tell the user when you're waiting on one. `
      : `creating and updating run without a separate approval, so be careful. `) +
    `Only touch this Drive when you're actually asked to; never create or change files as an ` +
    `incidental side effect.`
  );
}

export const googleDriveAdapter: IntegrationAdapter = {
  key: KEY,

  async resolveConfig(_ctx, rawConfig): Promise<Record<string, unknown>> {
    return {
      requireApproval: rawConfig.requireApproval !== false && rawConfig.requireApproval !== "false",
    };
  },

  async buildGrant(frame: ConfigureFrame, agent, config): Promise<string | null> {
    const connected = await db.getIntegrationConnection(agent.id, KEY);
    if (!connected || !google.isConfigured()) return null;
    let accessToken: string;
    try {
      accessToken = await getValidDriveToken(agent.id);
    } catch (e) {
      console.error(`runner[${agent.id}] configure: could not mint Drive token:`, e);
      return null;
    }
    const requireApproval = requireApprovalOf(config);
    frame.drive = { accessToken, email: connected.external_account ?? "your Drive", requireApproval };
    return promptBlock(connected.external_account ?? "your Drive", requireApproval);
  },

  async refreshCredentials(agent, _config, send): Promise<void> {
    const connected = await db.getIntegrationConnection(agent.id, KEY);
    if (!connected || !google.isConfigured()) return;
    try {
      const accessToken = await getValidDriveToken(agent.id);
      send({ type: "integration_credentials", key: KEY, accessToken });
    } catch (e) {
      console.error(`runner[${agent.id}] could not refresh Drive token:`, e);
    }
  },

  connection: {
    async start(ctx) {
      return {
        authorizeUrl: google.googleAuthorizeUrl({ scopes: google.DRIVE_SCOPES, redirectUri: ctx.redirectUri }),
        pending: { redirectUri: ctx.redirectUri },
      };
    },
    async complete(_ctx, pending, code) {
      const tok = await google.googleExchangeCode({ code, redirectUri: pending.redirectUri as string });
      return {
        externalAccount: tok.email,
        accessToken: tok.accessToken,
        refreshToken: tok.refreshToken,
        accessExpiresAt: tok.accessExpiresAt,
        scopes: tok.scopes,
      };
    },
  },
};
