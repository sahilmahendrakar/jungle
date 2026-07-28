import { pool } from "./pool";

// Per-user OAuth connections for the connection-based integrations (see
// migrations/042_multi_integration_connections.sql). A user can hold several connections for the
// same integration_key (e.g. two X accounts, two Notion workspaces) — each is its own row,
// identified by `id`. An agent's integration binds to one specific connection by id
// (agent_integrations.config.connectionId), not implicitly "the" connection for a user+key.
// Tokens are refreshed on demand from refresh_token by the owning adapter; `extra` carries the
// per-provider refresh material (token endpoint, issuer, client params) so a refresh needs no
// re-discovery.

export interface IntegrationConnectionRow {
  id: string;
  participant_id: string;
  integration_key: string;
  external_account: string | null;
  access_token: string;
  refresh_token: string | null;
  access_expires_at: string | null;
  scopes: string | null;
  extra: Record<string, unknown>;
  // True when the refresh grant is permanently dead (invalid_grant) — see migration 027.
  needs_reconnect: boolean;
  updated_at: string;
}

const COLUMNS =
  `id, participant_id, integration_key, external_account, access_token, refresh_token,
   access_expires_at, scopes, extra, needs_reconnect, updated_at`;

export async function getIntegrationConnectionById(id: string): Promise<IntegrationConnectionRow | null> {
  const { rows } = await pool.query<IntegrationConnectionRow>(
    `select ${COLUMNS} from integration_connections where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// Legacy single-connection accessor: the most-recently-updated connection for a user+key, or null.
// Multi-connection-aware callers should use listIntegrationConnectionsForKey instead — this exists
// for callers that only ever expected one connection (services/liana.ts), which still work
// correctly as long as a user has at most one connection for the keys they touch.
export async function getIntegrationConnection(
  participantId: string,
  key: string,
): Promise<IntegrationConnectionRow | null> {
  const { rows } = await pool.query<IntegrationConnectionRow>(
    `select ${COLUMNS}
       from integration_connections where participant_id = $1 and integration_key = $2
       order by updated_at desc limit 1`,
    [participantId, key],
  );
  return rows[0] ?? null;
}

// All of a user's integration connections, every key (for the Settings connections list / status).
export async function listIntegrationConnections(participantId: string): Promise<IntegrationConnectionRow[]> {
  const { rows } = await pool.query<IntegrationConnectionRow>(
    `select ${COLUMNS}
       from integration_connections where participant_id = $1
       order by updated_at desc`,
    [participantId],
  );
  return rows;
}

// A user's connections for one integration key — the account picker (agent create/edit) and the
// "add another account" list in Settings.
export async function listIntegrationConnectionsForKey(
  participantId: string,
  key: string,
): Promise<IntegrationConnectionRow[]> {
  const { rows } = await pool.query<IntegrationConnectionRow>(
    `select ${COLUMNS}
       from integration_connections where participant_id = $1 and integration_key = $2
       order by updated_at desc`,
    [participantId, key],
  );
  return rows;
}

// Add a new connection (fresh "Connect" or "connect another account" — never overwrites an
// existing row). Returns the created row.
export async function createIntegrationConnection(c: {
  participantId: string;
  key: string;
  externalAccount: string | null;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  scopes: string | null;
  extra?: Record<string, unknown>;
}): Promise<IntegrationConnectionRow> {
  const { rows } = await pool.query<IntegrationConnectionRow>(
    `insert into integration_connections
       (participant_id, integration_key, external_account, access_token, refresh_token,
        access_expires_at, scopes, extra)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     returning ${COLUMNS}`,
    [
      c.participantId, c.key, c.externalAccount, c.accessToken, c.refreshToken,
      c.accessExpiresAt, c.scopes, JSON.stringify(c.extra ?? {}),
    ],
  );
  return rows[0];
}

// Reconnect: replace one specific connection's grant in place (a fresh consent revives it — keeps
// the stored refresh token if this exchange didn't return a new one, since providers often only
// issue it on first consent).
export async function updateIntegrationConnectionById(
  id: string,
  c: {
    externalAccount: string | null;
    accessToken: string;
    refreshToken: string | null;
    accessExpiresAt: Date | null;
    scopes: string | null;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `update integration_connections set
       external_account = $2,
       access_token = $3,
       refresh_token = coalesce($4, refresh_token),
       access_expires_at = $5,
       scopes = $6,
       extra = $7,
       needs_reconnect = false,
       updated_at = now()
     where id = $1`,
    [id, c.externalAccount, c.accessToken, c.refreshToken, c.accessExpiresAt, c.scopes, JSON.stringify(c.extra ?? {})],
  );
}

// Update just the token material after a refresh (leaves external_account / extra).
export async function updateIntegrationTokensById(
  id: string,
  c: { accessToken: string; refreshToken: string | null; accessExpiresAt: Date | null },
): Promise<void> {
  await pool.query(
    `update integration_connections
       set access_token = $2,
           refresh_token = coalesce($3, refresh_token),
           access_expires_at = $4,
           updated_at = now()
     where id = $1`,
    [id, c.accessToken, c.refreshToken, c.accessExpiresAt],
  );
}

export async function deleteIntegrationConnectionById(id: string): Promise<void> {
  await pool.query(`delete from integration_connections where id = $1`, [id]);
}

// Legacy: drop ALL of a user's connections for one key (services/liana.ts, which has no
// multi-account UI and expects "disconnect" to fully clear a key).
export async function deleteIntegrationConnection(participantId: string, key: string): Promise<void> {
  await pool.query(
    `delete from integration_connections where participant_id = $1 and integration_key = $2`,
    [participantId, key],
  );
}

// Flag/unflag a dead refresh grant (mirrors setGoogleNeedsReconnect). Doesn't touch updated_at —
// that keeps reflecting the last token write.
export async function setIntegrationNeedsReconnectById(id: string, needsReconnect: boolean): Promise<void> {
  await pool.query(`update integration_connections set needs_reconnect = $2 where id = $1`, [id, needsReconnect]);
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
