import type { ConfigureFrame } from "@jungle/shared";
import * as db from "../db";
import * as google from "../google";
import { isInvalidGrantError } from "./oauth";
import type { IntegrationAdapter } from "./types";
import { resolveConnection } from "./backing";

// Google Analytics integration: the agent can query a connected GA4 property's traffic and event
// data via the runner's in-process analytics_* MCP tools — structurally identical to Google
// Calendar/Drive (per-user OAuth grant in integration_connections, connected once in Settings;
// attaching to an agent binds config.connectionId to one specific connection). Uses the same
// Google OAuth client as Gmail/Drive/Calendar (google.ts) with ANALYTICS_SCOPES.
//
// Read-only by scope (analytics.readonly) AND by policy: there is nothing to write, so unlike
// Drive/Calendar there's no approval toggle and no write-tool gating (mirrors X/Granola/PostHog/
// Mixpanel).

const KEY = "google-analytics";

// A valid access token for one Analytics connection, refreshing from the stored refresh token if
// near expiry (mirrors google-calendar.ts:getValidCalendarToken). A permanently-dead grant
// (invalid_grant / no refresh token) flags the connection needs_reconnect; a successful refresh
// clears it, so the state self-heals.
async function getValidAnalyticsToken(connectionId: string): Promise<string> {
  const row = await db.getIntegrationConnectionById(connectionId);
  if (!row) throw new Error(`Analytics connection ${connectionId} no longer exists`);
  const exp = row.access_expires_at ? new Date(row.access_expires_at).getTime() : Infinity;
  if (exp - Date.now() > 60_000) return row.access_token;
  if (!row.refresh_token) {
    await db.setIntegrationNeedsReconnectById(connectionId, true);
    throw new Error("Analytics token expired and no refresh token; reconnect");
  }
  let tok: Awaited<ReturnType<typeof google.googleRefreshToken>>;
  try {
    tok = await google.googleRefreshToken(row.refresh_token);
  } catch (e) {
    if (isInvalidGrantError(e)) await db.setIntegrationNeedsReconnectById(connectionId, true);
    throw e;
  }
  await db.updateIntegrationTokensById(connectionId, {
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken ?? row.refresh_token,
    accessExpiresAt: tok.accessExpiresAt,
  });
  // Self-heal: a successful refresh proves the grant is alive again.
  if (row.needs_reconnect) await db.setIntegrationNeedsReconnectById(connectionId, false);
  return tok.accessToken;
}

function promptBlock(email: string): string {
  return (
    `\n\n— Google Analytics: ${email} —\n` +
    `You can query product/site analytics with the analytics_* tools: analytics_list_properties ` +
    `(the GA4 properties this account can see, with their property ids) and analytics_run_report ` +
    `(sessions, users, events, conversions and other metrics, broken down by dimensions, over a ` +
    `date range) for one property. Both are read-only. Ask for a property id (or call ` +
    `analytics_list_properties first) if it's not clear which property a request is about.`
  );
}

// Shown when the integration is attached but the backing connection is permanently dead
// (needs_reconnect) or gone — so the agent can name the problem instead of silently having no
// analytics_* tools (mirrors google-calendar.ts's disconnectedBlock).
function disconnectedBlock(email: string): string {
  return (
    `\n\n— Google Analytics: connection expired —\n` +
    `Your Google Analytics integration (${email}) is attached, but the backing Google ` +
    `authorization has expired or been revoked, so the analytics_* tools are NOT available this ` +
    `session. Do NOT silently skip analytics work because of this. If the task at hand involves ` +
    `analytics, tell the user: your Google Analytics connection expired and needs to be ` +
    `reconnected in Settings → Connections — then you can pick the work back up.`
  );
}

export const googleAnalyticsAdapter: IntegrationAdapter = {
  key: KEY,

  // Bind to one specific Google Analytics connection (config.connectionId) — the picker's choice
  // (rawConfig.connectionId) when given, else the existing binding on reconfigure, else resolved
  // from the attacher (backing.ts: the human's sole connection, or, when an AGENT is attaching, the
  // account of the person it's acting for). Stores the display email for the agent card.
  async resolveConfig(ctx, rawConfig): Promise<Record<string, unknown>> {
    const requestedId = typeof rawConfig.connectionId === "string" ? rawConfig.connectionId : null;
    const existingId = typeof ctx.existing?.connectionId === "string" ? ctx.existing.connectionId : null;
    const conn = await resolveConnection(ctx, {
      key: KEY,
      displayName: "Google Analytics",
      requestedId: requestedId ?? existingId,
    });
    return { connectionId: conn.id, email: conn.external_account };
  },

  async buildGrant(frame: ConfigureFrame, agent, config): Promise<string | null> {
    const connectionId = typeof config.connectionId === "string" ? config.connectionId : null;
    if (!connectionId || !google.isConfigured()) return null;
    let accessToken: string;
    try {
      accessToken = await getValidAnalyticsToken(connectionId);
    } catch (e) {
      console.error(`runner[${agent.id}] configure: could not mint Analytics token:`, e);
      // Permanently dead or disconnected → tell the agent (see google-calendar.ts); transient → silent.
      const row = await db.getIntegrationConnectionById(connectionId).catch(() => null);
      const email = typeof config.email === "string" && config.email ? config.email : "your account";
      if (!row || row.needs_reconnect) return disconnectedBlock(email);
      return null;
    }
    const email = typeof config.email === "string" && config.email ? config.email : "your account";
    frame.analytics = { accessToken, email };
    return promptBlock(email);
  },

  async refreshCredentials(agent, config, send): Promise<void> {
    const connectionId = typeof config.connectionId === "string" ? config.connectionId : null;
    if (!connectionId || !google.isConfigured()) return;
    try {
      const accessToken = await getValidAnalyticsToken(connectionId);
      send({ type: "integration_credentials", key: KEY, accessToken });
    } catch (e) {
      console.error(`runner[${agent.id}] could not refresh Analytics token:`, e);
    }
  },

  connection: {
    async start(ctx) {
      return {
        authorizeUrl: google.googleAuthorizeUrl({ scopes: google.ANALYTICS_SCOPES, redirectUri: ctx.redirectUri }),
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
