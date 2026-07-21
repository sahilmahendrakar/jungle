import { createHash, randomBytes } from "node:crypto";
import * as db from "../db";
import { isInvalidGrantError } from "./oauth";
import type { ConnectionResult, ConnectionStart, ConnectionStartCtx, IntegrationConnection } from "./types";

// Generic OAuth 2.1 client for remote MCP servers (Linear, Notion, Granola). Implements the MCP
// authorization spec end to end so a provider needs no manual app registration:
//   1. Protected-resource metadata (RFC 9728) at the MCP URL → the authorization server.
//   2. Authorization-server metadata (RFC 8414) → authorize/token/registration endpoints.
//   3. Dynamic Client Registration (RFC 7591) → a client_id, cached per provider.
//   4. Authorization-code flow with PKCE (S256) and the resource indicator (RFC 8707).
//   5. Refresh-token grant to keep the short-lived access token fresh mid-session.
// The per-provider knobs (which MCP URL, which scopes) come from the catalog via McpProviderSpec.

export interface McpProviderSpec {
  key: string; // integration/catalog key; also the mcp_oauth_clients provider_key
  displayName: string; // shown as the connected-account label
  mcpUrl: string; // canonical MCP server URL — the bearer target AND the RFC 8707 resource
  scope?: string; // space-delimited scopes to request (provider-specific; omitted → none)
}

interface AsMeta {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  resource: string; // canonical resource id from protected-resource metadata (== mcpUrl)
}

// Discovery is stable per provider; cache it for the process so a connect/refresh doesn't re-fetch
// three well-knowns each time.
const metaCache = new Map<string, AsMeta>();

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`${url} returned non-JSON (${res.status})`);
  }
  if (!res.ok) {
    const err = (json.error as string) || res.statusText;
    const desc = (json.error_description as string) || "";
    throw new Error(`${url} → ${res.status} ${err}${desc ? `: ${desc}` : ""}`);
  }
  return json;
}

// RFC 9728: {origin}/.well-known/oauth-protected-resource{/path}. Try the path-suffixed form first
// (what our providers serve), then the bare one.
async function discover(spec: McpProviderSpec): Promise<AsMeta> {
  const cached = metaCache.get(spec.key);
  if (cached) return cached;

  const u = new URL(spec.mcpUrl);
  const prCandidates = [
    `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`,
    `${u.origin}/.well-known/oauth-protected-resource`,
  ];
  let pr: Record<string, unknown> | null = null;
  let lastErr: unknown;
  for (const c of prCandidates) {
    try {
      pr = await fetchJson(c);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!pr) throw new Error(`no protected-resource metadata for ${spec.mcpUrl}: ${String(lastErr)}`);

  const servers = pr.authorization_servers as string[] | undefined;
  const asUrl = servers?.[0];
  if (!asUrl) throw new Error(`protected-resource metadata for ${spec.mcpUrl} lists no authorization_servers`);
  const resource = (pr.resource as string) || spec.mcpUrl;

  const asOrigin = new URL(asUrl);
  const asCandidates = [
    ...new Set([
      // RFC 8414 inserts the well-known segment after the host, before any AS path.
      `${asOrigin.origin}/.well-known/oauth-authorization-server${asOrigin.pathname === "/" ? "" : asOrigin.pathname}`,
      `${asOrigin.origin}/.well-known/openid-configuration${asOrigin.pathname === "/" ? "" : asOrigin.pathname}`,
      // Real-world looseness (e.g. Mixpanel): the AS is announced with a path but serves its
      // metadata at the bare origin — try those before giving up.
      `${asOrigin.origin}/.well-known/oauth-authorization-server`,
      `${asOrigin.origin}/.well-known/openid-configuration`,
    ]),
  ];
  let as: Record<string, unknown> | null = null;
  for (const c of asCandidates) {
    try {
      as = await fetchJson(c);
      if (as.authorization_endpoint && as.token_endpoint) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!as?.authorization_endpoint || !as?.token_endpoint) {
    throw new Error(`no usable authorization-server metadata at ${asUrl}: ${String(lastErr)}`);
  }

  const meta: AsMeta = {
    issuer: (as.issuer as string) || asUrl,
    authorizationEndpoint: as.authorization_endpoint as string,
    tokenEndpoint: as.token_endpoint as string,
    registrationEndpoint: as.registration_endpoint as string | undefined,
    resource,
  };
  metaCache.set(spec.key, meta);
  return meta;
}

// Get-or-register the OAuth client for this provider (Dynamic Client Registration, cached in
// mcp_oauth_clients). Public client (token_endpoint_auth_method: none) + PKCE; if the AS still
// issues a client_secret we keep and use it.
async function ensureClient(
  spec: McpProviderSpec,
  meta: AsMeta,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret: string | null }> {
  const existing = await db.getMcpOAuthClient(spec.key);
  if (existing && existing.issuer === meta.issuer) {
    return { clientId: existing.client_id, clientSecret: existing.client_secret };
  }
  if (!meta.registrationEndpoint) {
    throw new Error(`${spec.key}: authorization server has no registration endpoint and no client is configured`);
  }
  const reg = await fetchJson(meta.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Jungle",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(spec.scope ? { scope: spec.scope } : {}),
    }),
  });
  const clientId = reg.client_id as string | undefined;
  if (!clientId) throw new Error(`${spec.key}: dynamic client registration returned no client_id`);
  const clientSecret = (reg.client_secret as string | undefined) ?? null;
  await db.upsertMcpOAuthClient({
    providerKey: spec.key,
    issuer: meta.issuer,
    clientId,
    clientSecret,
    metadata: reg,
  });
  return { clientId, clientSecret };
}

const b64url = (b: Buffer): string => b.toString("base64url");

async function postToken(tokenEndpoint: string, params: Record<string, string>): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}> {
  const json = await fetchJson(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const access = json.access_token as string | undefined;
  if (!access) throw new Error(`${tokenEndpoint}: token response had no access_token`);
  return {
    access_token: access,
    refresh_token: json.refresh_token as string | undefined,
    expires_in: json.expires_in as number | undefined,
    scope: json.scope as string | undefined,
  };
}

const expiryDate = (secs?: number): Date | null =>
  typeof secs === "number" ? new Date(Date.now() + secs * 1000) : null;

// The IntegrationConnection (start/complete) a remote-MCP adapter exposes to the generic OAuth
// routes. The per-attempt `pending` carries everything complete() needs so the callback is
// stateless beyond the route's state map.
export function mcpConnection(spec: McpProviderSpec): IntegrationConnection {
  return {
    async start(ctx: ConnectionStartCtx): Promise<ConnectionStart> {
      const meta = await discover(spec);
      const client = await ensureClient(spec, meta, ctx.redirectUri);
      const verifier = b64url(randomBytes(32));
      const challenge = b64url(createHash("sha256").update(verifier).digest());
      const url = new URL(meta.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("redirect_uri", ctx.redirectUri);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("resource", meta.resource);
      if (spec.scope) url.searchParams.set("scope", spec.scope);
      return {
        authorizeUrl: url.toString(),
        pending: {
          tokenEndpoint: meta.tokenEndpoint,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          verifier,
          redirectUri: ctx.redirectUri,
          resource: meta.resource,
        },
      };
    },

    async complete(_ctx, pending, code): Promise<ConnectionResult> {
      const clientSecret = (pending.clientSecret as string | null) ?? null;
      const tok = await postToken(pending.tokenEndpoint as string, {
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri as string,
        code_verifier: pending.verifier as string,
        client_id: pending.clientId as string,
        resource: pending.resource as string,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      });
      return {
        externalAccount: spec.displayName,
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token ?? null,
        accessExpiresAt: expiryDate(tok.expires_in),
        scopes: tok.scope ?? spec.scope ?? null,
        // Everything needed to refresh later without re-discovery.
        extra: {
          tokenEndpoint: pending.tokenEndpoint,
          clientId: pending.clientId,
          clientSecret,
          resource: pending.resource,
        },
      };
    },
  };
}

// Return a valid access token for a user's connection to this provider, refreshing from the stored
// refresh token if it's expired/near expiry (mirrors google.ts:getValidGmailToken). Throws if the
// user isn't connected or the token expired with no refresh token (→ reconnect). A permanently-dead
// grant (invalid_grant) flags the connection needs_reconnect; a successful refresh clears it
// (see migration 027).
export async function getValidMcpToken(spec: McpProviderSpec, participantId: string): Promise<string> {
  const row = await db.getIntegrationConnection(participantId, spec.key);
  if (!row) throw new Error(`participant ${participantId} is not connected to ${spec.key}`);
  const exp = row.access_expires_at ? new Date(row.access_expires_at).getTime() : Infinity;
  if (exp - Date.now() > 60_000) return row.access_token;
  if (!row.refresh_token) {
    await db.setIntegrationNeedsReconnect(participantId, spec.key, true);
    throw new Error(`${spec.key} token expired and no refresh token; reconnect`);
  }

  const extra = row.extra ?? {};
  const tokenEndpoint = (extra.tokenEndpoint as string) || (await discover(spec)).tokenEndpoint;
  const clientId = (extra.clientId as string) || (await db.getMcpOAuthClient(spec.key))?.client_id;
  const clientSecret = (extra.clientSecret as string | null) ?? null;
  const resource = (extra.resource as string) || spec.mcpUrl;
  if (!clientId) throw new Error(`${spec.key}: no OAuth client on file to refresh with`);

  let tok: Awaited<ReturnType<typeof postToken>>;
  try {
    tok = await postToken(tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: row.refresh_token,
      client_id: clientId,
      resource,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    });
  } catch (e) {
    if (isInvalidGrantError(e)) await db.setIntegrationNeedsReconnect(participantId, spec.key, true);
    throw e;
  }
  await db.updateIntegrationTokens({
    participantId,
    key: spec.key,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? row.refresh_token, // providers often omit it on refresh
    accessExpiresAt: expiryDate(tok.expires_in),
  });
  // Self-heal: a successful refresh proves the grant is alive again.
  if (row.needs_reconnect) await db.setIntegrationNeedsReconnect(participantId, spec.key, false);
  return tok.access_token;
}
