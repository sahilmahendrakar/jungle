-- 027_connection_needs_reconnect.sql — mark OAuth connections whose refresh token is dead.
--
-- A connection "needs reconnect" when its refresh grant is permanently dead (the provider
-- returned invalid_grant, or no refresh token was ever stored) — the only fix is sending the
-- user back through consent. Until now this failed silently: the identity row looked fine,
-- Settings showed "connected", and agents just lost their tools with no explanation (the
-- adapter's buildGrant returned null → no tools, no prompt block). The flag lets the backend
-- (a) tell the agent its integration is disconnected via the system prompt and (b) show a
-- "Reconnect needed" badge in Settings.
--
-- Set by the token helpers (google.ts:getValidGmailToken, integrations/google-drive.ts,
-- integrations/mcp-oauth.ts) on invalid_grant; cleared by a successful refresh (self-healing)
-- and by a fresh consent (upsert replaces the grant).

alter table google_identities
  add column if not exists needs_reconnect boolean not null default false;

alter table integration_connections
  add column if not exists needs_reconnect boolean not null default false;
