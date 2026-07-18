import type { ConfigureFrame } from "@jungle/shared";
import * as db from "../db";
import * as google from "../google";
import { ApiError } from "../http/errors";
import { isInvalidGrantError } from "./oauth";
import type { IntegrationAdapter } from "./types";

// Google Drive integration: the agent can search, read, and (with approval) create/update files in
// a connected Drive via the runner's in-process drive_* MCP tools — structurally like Gmail. The
// OAuth grant is PER-USER (integration_connections), connected once in Settings; attaching to an
// agent binds config.backingParticipantId to the connecting user. Uses the same Google OAuth client
// as Gmail (google.ts) with DRIVE_SCOPES.

const KEY = "google-drive";

function requireApprovalOf(config: Record<string, unknown>): boolean {
  return config.requireApproval !== false; // default on
}

// A valid access token for a user's Drive connection, refreshing from the stored refresh token if
// near expiry (mirrors google.ts:getValidGmailToken but reads/writes integration_connections).
// A permanently-dead grant (invalid_grant / no refresh token) flags the connection
// needs_reconnect; a successful refresh clears it (see migration 027).
async function getValidDriveToken(participantId: string): Promise<string> {
  const row = await db.getIntegrationConnection(participantId, KEY);
  if (!row) throw new Error(`participant ${participantId} has no Google Drive connection`);
  const exp = row.access_expires_at ? new Date(row.access_expires_at).getTime() : Infinity;
  if (exp - Date.now() > 60_000) return row.access_token;
  if (!row.refresh_token) {
    await db.setIntegrationNeedsReconnect(participantId, KEY, true);
    throw new Error("Drive token expired and no refresh token; reconnect");
  }
  let tok: Awaited<ReturnType<typeof google.googleRefreshToken>>;
  try {
    tok = await google.googleRefreshToken(row.refresh_token);
  } catch (e) {
    if (isInvalidGrantError(e)) await db.setIntegrationNeedsReconnect(participantId, KEY, true);
    throw e;
  }
  await db.updateIntegrationTokens({
    participantId,
    key: KEY,
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken ?? row.refresh_token,
    accessExpiresAt: tok.accessExpiresAt,
  });
  // Self-heal: a successful refresh proves the grant is alive again.
  if (row.needs_reconnect) await db.setIntegrationNeedsReconnect(participantId, KEY, false);
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

// Shown when the integration is attached but the backing connection is permanently dead
// (needs_reconnect) or gone — so the agent can name the problem instead of silently having no
// drive_* tools (mirrors gmail.ts's disconnectedBlock).
function disconnectedBlock(email: string): string {
  return (
    `\n\n— Google Drive: connection expired —\n` +
    `Your Google Drive integration (${email}) is attached, but the backing Google authorization ` +
    `has expired or been revoked, so the drive_* tools are NOT available this session. Do NOT ` +
    `silently skip Drive work because of this. If the task at hand involves Drive, tell the user: ` +
    `your Google Drive connection expired and needs to be reconnected in Settings → Connections — ` +
    `then you can pick the work back up.`
  );
}

export const googleDriveAdapter: IntegrationAdapter = {
  key: KEY,

  // Bind to the attaching user's Drive connection (like gmail) — 400 if not connected; a
  // reconfigure keeps the original backing user. Stores the display email for the agent card.
  async resolveConfig(ctx, rawConfig): Promise<Record<string, unknown>> {
    const requireApproval = rawConfig.requireApproval !== false && rawConfig.requireApproval !== "false";
    const existingBacking =
      typeof ctx.existing?.backingParticipantId === "string" ? ctx.existing.backingParticipantId : null;
    if (existingBacking) {
      return { backingParticipantId: existingBacking, email: ctx.existing?.email ?? null, requireApproval };
    }
    const conn = await db.getIntegrationConnection(ctx.me.id, KEY);
    if (!conn) throw new ApiError(400, "connect your Google Drive account in Settings first");
    return { backingParticipantId: ctx.me.id, email: conn.external_account, requireApproval };
  },

  async buildGrant(frame: ConfigureFrame, agent, config): Promise<string | null> {
    const backing = typeof config.backingParticipantId === "string" ? config.backingParticipantId : null;
    if (!backing || !google.isConfigured()) return null;
    let accessToken: string;
    try {
      accessToken = await getValidDriveToken(backing);
    } catch (e) {
      console.error(`runner[${agent.id}] configure: could not mint Drive token:`, e);
      // Permanently dead or disconnected → tell the agent (see gmail.ts); transient → silent.
      const row = await db.getIntegrationConnection(backing, KEY).catch(() => null);
      const email = typeof config.email === "string" && config.email ? config.email : "your Drive";
      if (!row || row.needs_reconnect) return disconnectedBlock(email);
      return null;
    }
    const email = typeof config.email === "string" && config.email ? config.email : "your Drive";
    const requireApproval = requireApprovalOf(config);
    frame.drive = { accessToken, email, requireApproval };
    return promptBlock(email, requireApproval);
  },

  async refreshCredentials(agent, config, send): Promise<void> {
    const backing = typeof config.backingParticipantId === "string" ? config.backingParticipantId : null;
    if (!backing || !google.isConfigured()) return;
    try {
      const accessToken = await getValidDriveToken(backing);
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
