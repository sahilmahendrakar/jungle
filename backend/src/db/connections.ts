import { pool } from "./pool";

// Per-user OAuth connections for the connection-based integrations (see
// migrations/015_integration_connections_per_user.sql). One grant per (participant, integration_key)
// — you connect your accounts once in Settings, like github_identities / google_identities. Tokens
// are refreshed on demand from refresh_token by the owning adapter; `extra` carries the per-provider
// refresh material (token endpoint, issuer, client params) so a refresh needs no re-discovery.

export interface IntegrationConnectionRow {
  participant_id: string;
  integration_key: string;
  external_account: string | null;
  access_token: string;
  refresh_token: string | null;
  access_expires_at: string | null;
  scopes: string | null;
  extra: Record<string, unknown>;
}

export async function getIntegrationConnection(
  participantId: string,
  key: string,
): Promise<IntegrationConnectionRow | null> {
  const { rows } = await pool.query<IntegrationConnectionRow>(
    `select participant_id, integration_key, external_account, access_token, refresh_token,
            access_expires_at, scopes, extra
       from integration_connections where participant_id = $1 and integration_key = $2`,
    [participantId, key],
  );
  return rows[0] ?? null;
}

// All of a user's integration connections (for the Settings connections list / status).
export async function listIntegrationConnections(participantId: string): Promise<IntegrationConnectionRow[]> {
  const { rows } = await pool.query<IntegrationConnectionRow>(
    `select participant_id, integration_key, external_account, access_token, refresh_token,
            access_expires_at, scopes, extra
       from integration_connections where participant_id = $1`,
    [participantId],
  );
  return rows;
}

// Store (or replace) a user's OAuth grant for an integration.
export async function upsertIntegrationConnection(c: {
  participantId: string;
  key: string;
  externalAccount: string | null;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  scopes: string | null;
  extra?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `insert into integration_connections
       (participant_id, integration_key, external_account, access_token, refresh_token,
        access_expires_at, scopes, extra, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now())
     on conflict (participant_id, integration_key) do update set
       external_account = excluded.external_account,
       access_token = excluded.access_token,
       -- keep the stored refresh token if this exchange didn't return a new one (providers often
       -- only issue it on first consent).
       refresh_token = coalesce(excluded.refresh_token, integration_connections.refresh_token),
       access_expires_at = excluded.access_expires_at,
       scopes = excluded.scopes,
       extra = excluded.extra,
       updated_at = now()`,
    [
      c.participantId, c.key, c.externalAccount, c.accessToken, c.refreshToken,
      c.accessExpiresAt, c.scopes, JSON.stringify(c.extra ?? {}),
    ],
  );
}

// Update just the token material after a refresh (leaves external_account / extra).
export async function updateIntegrationTokens(c: {
  participantId: string;
  key: string;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
}): Promise<void> {
  await pool.query(
    `update integration_connections
       set access_token = $3,
           refresh_token = coalesce($4, refresh_token),
           access_expires_at = $5,
           updated_at = now()
     where participant_id = $1 and integration_key = $2`,
    [c.participantId, c.key, c.accessToken, c.refreshToken, c.accessExpiresAt],
  );
}

export async function deleteIntegrationConnection(participantId: string, key: string): Promise<void> {
  await pool.query(
    `delete from integration_connections where participant_id = $1 and integration_key = $2`,
    [participantId, key],
  );
}

// --- Registered OAuth clients for remote MCP providers (Dynamic Client Registration) ---

export interface McpOAuthClientRow {
  provider_key: string;
  issuer: string;
  client_id: string;
  client_secret: string | null;
  metadata: Record<string, unknown>;
}

export async function getMcpOAuthClient(providerKey: string): Promise<McpOAuthClientRow | null> {
  const { rows } = await pool.query<McpOAuthClientRow>(
    `select provider_key, issuer, client_id, client_secret, metadata
       from mcp_oauth_clients where provider_key = $1`,
    [providerKey],
  );
  return rows[0] ?? null;
}

export async function upsertMcpOAuthClient(c: {
  providerKey: string;
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `insert into mcp_oauth_clients (provider_key, issuer, client_id, client_secret, metadata)
     values ($1,$2,$3,$4,$5)
     on conflict (provider_key) do update set
       issuer = excluded.issuer,
       client_id = excluded.client_id,
       client_secret = excluded.client_secret,
       metadata = excluded.metadata`,
    [c.providerKey, c.issuer, c.clientId, c.clientSecret, JSON.stringify(c.metadata ?? {})],
  );
}
