import "./env";
import * as db from "./db";

// Google user-OAuth credentials (GOOGLE_OAUTH_CLIENT_ID / _SECRET in .env). This is the per-user
// "connect your Google account" flow that backs the Gmail integration — the direct analog of the
// GitHub user-OAuth flow in github.ts. We request offline access so we get a refresh token and can
// mint fresh Gmail access tokens (~1h each) on demand for the runner.
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";
// Must exactly match an authorized redirect URI on the OAuth client.
export const REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "http://localhost:3001/auth/google/callback";

// openid+email capture the connected address; gmail.modify grants read + send + label/modify
// (but NOT permanent delete). gmail.modify is a Google RESTRICTED scope — the app needs Google's
// OAuth verification before non-test users can grant it in production.
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"];

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

export function isConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

// Where we send a human to grant access. `state` is our CSRF/round-trip token.
export function authorizeUrl(state: string): string {
  const u = new URL(AUTHORIZE);
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("access_type", "offline"); // ask for a refresh token
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("prompt", "consent"); // force a refresh token on every (re)connect
  u.searchParams.set("state", state);
  return u.toString();
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number; // seconds (~1h for Google access tokens)
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const json = (await res.json()) as TokenResponse;
  if (json.error) throw new Error(`google oauth: ${json.error} — ${json.error_description ?? ""}`);
  return json;
}

const expiryDate = (secs?: number): Date | null =>
  typeof secs === "number" ? new Date(Date.now() + secs * 1000) : null;

// The connected account's email: from the id_token's `email` claim (present with openid+email),
// falling back to the userinfo endpoint. No signature check needed — the token came straight from
// Google's token endpoint over TLS.
async function accountEmail(tok: TokenResponse): Promise<string> {
  const idt = tok.id_token;
  if (idt) {
    const parts = idt.split(".");
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        if (typeof payload.email === "string" && payload.email) return payload.email;
      } catch {
        /* fall through to userinfo */
      }
    }
  }
  if (tok.access_token) {
    const res = await fetch(USERINFO, { headers: { authorization: `Bearer ${tok.access_token}` } });
    if (res.ok) {
      const info = (await res.json()) as { email?: string };
      if (info.email) return info.email;
    }
  }
  throw new Error("could not determine Google account email");
}

// Exchange the callback `code` for tokens, resolve the account email, and persist the identity.
export async function exchangeCodeAndStore(
  participantId: string,
  code: string,
): Promise<{ email: string }> {
  const tok = await postToken({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });
  if (!tok.access_token) throw new Error("google oauth: no access_token in response");
  const email = await accountEmail(tok);
  await db.upsertGoogleIdentity({
    participantId,
    email,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? null,
    accessExpiresAt: expiryDate(tok.expires_in),
    scopes: tok.scope ?? null,
  });
  return { email };
}

// Return a valid Gmail access token for the participant, refreshing if it's expired/near-expiry.
// The Gmail-integration runner path calls this per drain (see runners.ts) — mirrors github.ts's
// getValidToken.
export async function getValidGmailToken(participantId: string): Promise<string> {
  const id = await db.getGoogleIdentity(participantId);
  if (!id) throw new Error("participant has not connected Google");
  const exp = id.access_expires_at ? new Date(id.access_expires_at).getTime() : Infinity;
  if (exp - Date.now() > 60_000) return id.access_token; // still good (>60s headroom)
  if (!id.refresh_token) throw new Error("access token expired and no refresh token; reconnect Google");

  const tok = await postToken({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: id.refresh_token,
  });
  if (!tok.access_token) throw new Error("google oauth: refresh returned no access_token");
  await db.updateGoogleTokens({
    participantId,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? id.refresh_token, // Google usually omits it on refresh
    accessExpiresAt: expiryDate(tok.expires_in),
  });
  return tok.access_token;
}

export interface GoogleStatus {
  connected: boolean;
  email?: string;
}

// Connection status for the settings page.
export async function googleStatus(participantId: string): Promise<GoogleStatus> {
  const id = await db.getGoogleIdentity(participantId);
  return id ? { connected: true, email: id.email } : { connected: false };
}
