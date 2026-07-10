import { createHash, randomBytes } from "node:crypto";
import type { ConfigureFrame, XIntegrationConfig } from "@jungle/shared";
import * as db from "../db";
import { ApiError } from "../http/errors";
import type {
  ConnectionResult,
  ConnectionStart,
  ConnectionStartCtx,
  IntegrationAdapter,
} from "./types";

// X (Twitter) integration: the agent can read activity on a connected X account — recent tweets,
// mentions, replies, notifications — via the runner's in-process x_* MCP tools. Connection-based
// (per-user OAuth 2.0 PKCE User Context grant stored in integration_connections, key "x"); the
// per-agent config holds only which participant's connection backs it and the @handle for display.
// Read-only by design (Basic API tier), so there are no write tools and nothing to approve.
//
// X has no hosted MCP server, so unlike Linear/Notion this is NOT a remote-MCP integration — it's
// an in-process server (like Gmail/Drive). The token is minted server-side per drain and pushed to
// the runner on the configure frame; mid-session refreshes reuse the generic
// IntegrationCredentialsFrame keyed "x" (same as Google Drive).

const KEY = "x";

// X OAuth 2.0 confidential client credentials (developer portal → your app → "Keys and tokens" →
// OAuth 2.0 Client ID and Secret). The secret never leaves the backend: the token endpoint
// authenticates with HTTP Basic (client_id:client_secret).
const CLIENT_ID = process.env.X_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.X_CLIENT_SECRET ?? "";

// X OAuth 2.0 User Context scopes. tweet.read + users.read cover recent tweets / mentions / the
// authenticated user; follows.read lets us resolve follower context; offline.access yields a
// refresh token so we can mint fresh access tokens (2h each) without re-prompting.
const SCOPES = ["tweet.read", "users.read", "follows.read", "offline.access"];

const AUTHORIZE = "https://twitter.com/i/oauth2/authorize";
const TOKEN = "https://api.twitter.com/2/oauth2/token";
const ME = "https://api.twitter.com/2/users/me";

export function isConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

function basicAuthHeader(): string {
  return "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
}

interface XTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number; // seconds (~2h for X User Context tokens)
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

// POST the token endpoint with HTTP Basic client auth (X requires this for confidential clients;
// client_id/client_secret in the body is rejected). PKCE verifier is sent on the code exchange.
async function postToken(params: Record<string, string>): Promise<XTokenResponse> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicAuthHeader(),
    },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json()) as XTokenResponse;
  if (json.error) throw new Error(`x oauth: ${json.error} — ${json.error_description ?? ""}`);
  return json;
}

const expiryDate = (secs?: number): Date | null =>
  typeof secs === "number" ? new Date(Date.now() + secs * 1000) : null;

// The authenticated user's id/name/username — used as the connected-account label (@handle) and
// to bind the agent to the right account. user.fields is required by X to return anything useful.
async function fetchMyUser(accessToken: string): Promise<{ id: string; name: string; username: string }> {
  const res = await fetch(`${ME}?user.fields=id,name,username`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json()) as {
    data?: { id: string; name: string; username: string };
    error?: { message?: string; detail?: string };
  };
  if (!res.ok || !json.data) {
    throw new Error(`x /users/me -> ${res.status}: ${json.error?.message ?? json.error?.detail ?? "no data"}`);
  }
  return json.data;
}

// A valid access token for a user's X connection, refreshing from the stored refresh token if it's
// expired/near expiry (mirrors google-drive.ts:getValidDriveToken). Throws if the user isn't
// connected or the token expired with no refresh token (→ reconnect).
async function getValidXToken(participantId: string): Promise<string> {
  const row = await db.getIntegrationConnection(participantId, KEY);
  if (!row) throw new Error(`participant ${participantId} has no X connection`);
  const exp = row.access_expires_at ? new Date(row.access_expires_at).getTime() : Infinity;
  if (exp - Date.now() > 60_000) return row.access_token;
  if (!row.refresh_token) throw new Error("X token expired and no refresh token; reconnect");
  const tok = await postToken({
    grant_type: "refresh_token",
    refresh_token: row.refresh_token,
  });
  if (!tok.access_token) throw new Error("x oauth: refresh returned no access_token");
  await db.updateIntegrationTokens({
    participantId,
    key: KEY,
    accessToken: tok.access_token,
    // X returns a new refresh_token on each refresh; fall back to the stored one if omitted.
    refreshToken: tok.refresh_token ?? row.refresh_token,
    accessExpiresAt: expiryDate(tok.expires_in),
  });
  return tok.access_token;
}

function parseXConfig(config: Record<string, unknown>): XIntegrationConfig | null {
  const c = config as Partial<XIntegrationConfig>;
  if (typeof c.backingParticipantId !== "string" || typeof c.account !== "string") return null;
  return { backingParticipantId: c.backingParticipantId, account: c.account };
}

function promptBlock(account: string): string {
  return (
    `\n\n— X: ${account} —\n` +
    `You can read activity on this X account with the x_* tools: x_my_recent_tweets (your latest ` +
    `posts), x_mentions (tweets mentioning you), x_replies_to_me (replies to your tweets), ` +
    `x_notifications (recent notifications), x_search (search recent public tweets), and x_get_user ` +
    `(look up a user). All are read-only. When asked to "summarize activity", pull a recent window ` +
    `across mentions, replies and notifications and give a concise digest — don't dump raw JSON. ` +
    `Only reach for X when you're actually asked to.`
  );
}

export const xAdapter: IntegrationAdapter = {
  key: KEY,

  // Bind to the attaching user's X connection (like Google Drive) — 400 if not connected; a
  // reconfigure keeps the original backing user. Stores the @handle for the agent card.
  async resolveConfig(ctx, rawConfig): Promise<Record<string, unknown>> {
    const existingBacking =
      typeof ctx.existing?.backingParticipantId === "string" ? ctx.existing.backingParticipantId : null;
    if (existingBacking) {
      return { backingParticipantId: existingBacking, account: ctx.existing?.account ?? null };
    }
    const conn = await db.getIntegrationConnection(ctx.me.id, KEY);
    if (!conn) throw new ApiError(400, "connect your X account in Settings first");
    return { backingParticipantId: ctx.me.id, account: conn.external_account };
  },

  // Mint the X token up front so the prompt only advertises x_* tools when the connection is
  // actually usable (e.g. not when the backing user disconnected) — otherwise the agent would see
  // x_* instructions with no tools behind them.
  async buildGrant(frame: ConfigureFrame, agent, config): Promise<string | null> {
    const x = parseXConfig(config);
    if (!x || !isConfigured()) return null;
    let accessToken: string;
    try {
      accessToken = await getValidXToken(x.backingParticipantId);
    } catch (e) {
      console.error(`runner[${agent.id}] configure: could not mint X token:`, e);
      return null;
    }
    const account = x.account || "your X account";
    frame.x = { accessToken, account };
    return promptBlock(account);
  },

  async refreshCredentials(agent, config, send): Promise<void> {
    const x = parseXConfig(config);
    if (!x || !isConfigured()) return;
    try {
      const accessToken = await getValidXToken(x.backingParticipantId);
      send({ type: "integration_credentials", key: KEY, accessToken });
    } catch (e) {
      console.error(`runner[${agent.id}] could not refresh X token:`, e);
    }
  },

  // OAuth 2.0 PKCE User Context connect/callback. The generic integrations route drives this:
  // start() builds the authorize URL + PKCE verifier; on callback, complete() exchanges the code,
  // resolves the @handle, and the route persists the grant into integration_connections.
  connection: {
    async start(ctx: ConnectionStartCtx): Promise<ConnectionStart> {
      if (!isConfigured()) throw new ApiError(500, "X OAuth client is not configured (X_CLIENT_ID/SECRET)");
      // PKCE: X requires S256. Verifier is 43-128 url-safe chars; 32 random bytes base64url = 43.
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const url = new URL(AUTHORIZE);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", CLIENT_ID);
      url.searchParams.set("redirect_uri", ctx.redirectUri);
      url.searchParams.set("scope", SCOPES.join(" "));
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return {
        authorizeUrl: url.toString(),
        pending: { verifier, redirectUri: ctx.redirectUri },
      };
    },

    async complete(_ctx: ConnectionStartCtx, pending: Record<string, unknown>, code: string): Promise<ConnectionResult> {
      const tok = await postToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri as string,
        code_verifier: pending.verifier as string,
      });
      if (!tok.access_token) throw new Error("x oauth: no access_token in response");
      const user = await fetchMyUser(tok.access_token);
      return {
        externalAccount: `@${user.username}`,
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token ?? null,
        accessExpiresAt: expiryDate(tok.expires_in),
        scopes: tok.scope ?? SCOPES.join(" "),
        // Carry the resolved user so buildGrant/display can use it without a re-fetch; the
        // refresh_token (when present) is what getValidXToken needs and is stored on the row.
        extra: { userId: user.id, name: user.name, username: user.username },
      };
    },
  },
};
