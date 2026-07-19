import type { ConfigureFrame } from "@jungle/shared";
import * as db from "../db";
import * as google from "../google";
import { ApiError } from "../http/errors";
import { isInvalidGrantError } from "./oauth";
import type { IntegrationAdapter } from "./types";

// Google Calendar integration: the agent can list/read events and (with approval) create/update
// them on a connected Google Calendar via the runner's in-process calendar_* MCP tools —
// structurally identical to Google Drive. The OAuth grant is PER-USER (integration_connections),
// connected once in Settings; attaching to an agent binds config.backingParticipantId to the
// connecting user. Uses the same Google OAuth client as Gmail/Drive (google.ts) with
// CALENDAR_SCOPES.

const KEY = "google-calendar";

function requireApprovalOf(config: Record<string, unknown>): boolean {
  return config.requireApproval !== false; // default on
}

// A valid access token for a user's Calendar connection, refreshing from the stored refresh
// token if near expiry (mirrors google-drive.ts:getValidDriveToken). A permanently-dead grant
// (invalid_grant / no refresh token) flags the connection needs_reconnect; a successful refresh
// clears it, so the state self-heals.
async function getValidCalendarToken(participantId: string): Promise<string> {
  const row = await db.getIntegrationConnection(participantId, KEY);
  if (!row) throw new Error(`participant ${participantId} has no Google Calendar connection`);
  const exp = row.access_expires_at ? new Date(row.access_expires_at).getTime() : Infinity;
  if (exp - Date.now() > 60_000) return row.access_token;
  if (!row.refresh_token) {
    await db.setIntegrationNeedsReconnect(participantId, KEY, true);
    throw new Error("Calendar token expired and no refresh token; reconnect");
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
    `\n\n— Google Calendar: ${email} —\n` +
    `You can act on this calendar with the calendar_* tools: calendar_list (events in a time ` +
    `range), calendar_get (one event's details), calendar_create (new event), calendar_update ` +
    `(change an event). Listing and reading are always available; ` +
    (requireApproval
      ? `creating and updating require a human's approval, so you'll hit a confirmation prompt — ` +
        `tell the user when you're waiting on one. `
      : `creating and updating run without a separate approval, so be careful. `) +
    `Only touch this calendar when you're actually asked to; never create or change events as an ` +
    `incidental side effect.`
  );
}

// Shown when the integration is attached but the backing connection is permanently dead
// (needs_reconnect) or gone — so the agent can name the problem instead of silently having no
// calendar_* tools (mirrors google-drive.ts's disconnectedBlock).
function disconnectedBlock(email: string): string {
  return (
    `\n\n— Google Calendar: connection expired —\n` +
    `Your Google Calendar integration (${email}) is attached, but the backing Google ` +
    `authorization has expired or been revoked, so the calendar_* tools are NOT available this ` +
    `session. Do NOT silently skip calendar work because of this. If the task at hand involves ` +
    `the calendar, tell the user: your Google Calendar connection expired and needs to be ` +
    `reconnected in Settings → Connections — then you can pick the work back up.`
  );
}

export const googleCalendarAdapter: IntegrationAdapter = {
  key: KEY,

  // Bind to the attaching user's Calendar connection (like Drive) — 400 if not connected; a
  // reconfigure keeps the original backing user. Stores the display email for the agent card.
  async resolveConfig(ctx, rawConfig): Promise<Record<string, unknown>> {
    const requireApproval = rawConfig.requireApproval !== false && rawConfig.requireApproval !== "false";
    const existingBacking =
      typeof ctx.existing?.backingParticipantId === "string" ? ctx.existing.backingParticipantId : null;
    if (existingBacking) {
      return { backingParticipantId: existingBacking, email: ctx.existing?.email ?? null, requireApproval };
    }
    const conn = await db.getIntegrationConnection(ctx.me.id, KEY);
    if (!conn) throw new ApiError(400, "connect your Google Calendar account in Settings first");
    return { backingParticipantId: ctx.me.id, email: conn.external_account, requireApproval };
  },

  async buildGrant(frame: ConfigureFrame, agent, config): Promise<string | null> {
    const backing = typeof config.backingParticipantId === "string" ? config.backingParticipantId : null;
    if (!backing || !google.isConfigured()) return null;
    let accessToken: string;
    try {
      accessToken = await getValidCalendarToken(backing);
    } catch (e) {
      console.error(`runner[${agent.id}] configure: could not mint Calendar token:`, e);
      // Permanently dead or disconnected → tell the agent (see google-drive.ts); transient → silent.
      const row = await db.getIntegrationConnection(backing, KEY).catch(() => null);
      const email = typeof config.email === "string" && config.email ? config.email : "your calendar";
      if (!row || row.needs_reconnect) return disconnectedBlock(email);
      return null;
    }
    const email = typeof config.email === "string" && config.email ? config.email : "your calendar";
    const requireApproval = requireApprovalOf(config);
    frame.calendar = { accessToken, email, requireApproval };
    return promptBlock(email, requireApproval);
  },

  async refreshCredentials(agent, config, send): Promise<void> {
    const backing = typeof config.backingParticipantId === "string" ? config.backingParticipantId : null;
    if (!backing || !google.isConfigured()) return;
    try {
      const accessToken = await getValidCalendarToken(backing);
      send({ type: "integration_credentials", key: KEY, accessToken });
    } catch (e) {
      console.error(`runner[${agent.id}] could not refresh Calendar token:`, e);
    }
  },

  connection: {
    async start(ctx) {
      return {
        authorizeUrl: google.googleAuthorizeUrl({ scopes: google.CALENDAR_SCOPES, redirectUri: ctx.redirectUri }),
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
