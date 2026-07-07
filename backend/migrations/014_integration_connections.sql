-- 014_integration_connections.sql — per-agent OAuth connections + dynamic MCP OAuth clients.
--
-- The next wave of integrations (Linear, Notion, Granola via their remote MCP servers, and
-- Google Drive) each hold a per-AGENT OAuth grant, rather than the per-participant identity that
-- backs Gmail (google_identities). A human authorizes the connection from the agent's profile;
-- the grant belongs to that agent. This is the store for those grants.
--
-- Two tables:
--   integration_connections — one OAuth grant per (agent, integration_key). Tokens are refreshed
--     on demand from refresh_token; `extra` carries per-provider refresh material (token endpoint,
--     issuer, etc.) so the adapter can refresh without re-discovering. Cascades with the agent.
--   mcp_oauth_clients — the OAuth *client* registered (once, via Dynamic Client Registration) with
--     a remote MCP provider's authorization server. Keyed by provider, shared across all agents
--     connecting to that provider. Holds the client_id (+ client_secret if the AS issued one).
--
-- MVP: tokens/secrets stored plaintext on the box (same precedent as github_identities /
-- google_identities); encrypt at rest before any real multi-tenant deployment.

create table if not exists integration_connections (
  agent_id          uuid not null references participants(id) on delete cascade,
  integration_key   text not null,                     -- catalog key: linear | notion | granola | google-drive | …
  external_account  text,                              -- display label (email, workspace name, provider)
  access_token      text not null,
  refresh_token     text,
  access_expires_at timestamptz,                        -- when access_token expires
  scopes            text,                              -- space-delimited (informational)
  extra             jsonb not null default '{}'::jsonb, -- per-provider refresh material (token endpoint, issuer, …)
  created_by        uuid references participants(id) on delete set null,  -- who authorized it
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (agent_id, integration_key)
);

create table if not exists mcp_oauth_clients (
  provider_key      text primary key,                  -- catalog key of the remote-MCP integration
  issuer            text not null,                     -- the authorization server's issuer URL
  client_id         text not null,
  client_secret     text,                              -- present only if the AS issued one (confidential client)
  metadata          jsonb not null default '{}'::jsonb, -- discovered AS metadata (endpoints, DCR response)
  registered_at     timestamptz not null default now()
);
