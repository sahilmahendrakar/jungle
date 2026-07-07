import type { ConfigureFrame, BackendToRunner } from "@jungle/shared";
import type * as db from "../db";

// An IntegrationAdapter is the per-service plugin behind Jungle's integration catalog. One adapter
// per integration key (github, gmail, linear, …); the registry (registry.ts) dispatches by key so
// runners.ts and routes/agents.ts contain no per-service branches. This mirrors the Provisioner
// seam in provisioner.ts — a small interface with a registry keyed by a stored value.
//
// The lifecycle an adapter participates in:
//   • resolveConfig — when a human attaches/reconfigures the integration (routes/agents.ts).
//   • buildGrant    — when the runner connects and we build its `configure` frame (runners.ts):
//                     mint any tokens, set the frame fields the runner reads, and return the
//                     system-prompt block advertising this integration's tools.
//   • refreshCredentials — before each drain, re-mint short-lived tokens so a long-lived runner
//                     never starts a turn with an expired credential.
//   • connection    — the OAuth connect/callback/status/disconnect lifecycle for connection-based
//                     integrations (added in Phase 2; see connection.ts).

export interface ResolveConfigCtx {
  // The human attaching/reconfiguring the integration (their workspace-scoped participant).
  me: db.Participant;
  agentId: string;
  // The integration's previously-persisted config, if this is a reconfigure (else null).
  existing: Record<string, unknown> | null;
}

// --- OAuth connection lifecycle (connection-based integrations: linear, notion, granola, drive) ---

export interface ConnectionStartCtx {
  // The human connecting the account in Settings → Connections (their workspace-scoped participant).
  // The grant is stored per-user; agents that attach the integration reference this participant.
  me: db.Participant;
  // The absolute callback URL the provider must redirect back to (built by the route from the
  // backend's public origin). Adapters echo it into the authorize request verbatim.
  redirectUri: string;
}

export interface ConnectionStart {
  // Where to send the browser to authorize.
  authorizeUrl: string;
  // Opaque per-attempt state the route stashes (keyed by the OAuth `state`) and hands back to
  // complete(): PKCE verifier, discovered token endpoint, DCR client id, requested scopes, …
  // Must be JSON-serializable.
  pending: Record<string, unknown>;
}

export interface ConnectionResult {
  externalAccount: string | null; // display label (email, workspace, provider name)
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  scopes: string | null;
  extra?: Record<string, unknown>; // persisted on the connection row for later refreshes
}

// Connection-based integrations implement this. The generic routes in http/routes/integrations.ts
// drive it: start() → redirect the browser; on callback, complete() → persist the grant into
// integration_connections. Status and disconnect are generic (read/delete the row) and need no
// per-adapter code.
export interface IntegrationConnection {
  start(ctx: ConnectionStartCtx): Promise<ConnectionStart>;
  complete(
    ctx: ConnectionStartCtx,
    pending: Record<string, unknown>,
    code: string,
  ): Promise<ConnectionResult>;
}

export interface IntegrationAdapter {
  key: string;

  // Validate + normalize the config to persist on attach/reconfigure. Throw ApiError to reject.
  // Omitted → the client-supplied config is stored as-is.
  resolveConfig?(
    ctx: ResolveConfigCtx,
    rawConfig: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  // Contribute this integration's grant to the agent's `configure` frame: mint tokens and set the
  // frame fields the runner reads (frame.git / frame.gmail / frame.mcpIntegrations / …), then
  // return the system-prompt block to advertise its tools — or null to advertise nothing this turn
  // (e.g. the backing account disconnected and no token could be minted). Mutates `frame`.
  // `config` is the persisted agent_integrations.config row for this key.
  buildGrant(
    frame: ConfigureFrame,
    agent: db.AgentRow,
    config: Record<string, unknown>,
  ): Promise<string | null>;

  // Push a fresh credentials frame before a drain (short-lived OAuth token refresh). Optional;
  // no-op for integrations whose grant doesn't expire mid-session. `send` writes to the runner.
  refreshCredentials?(
    agent: db.AgentRow,
    config: Record<string, unknown>,
    send: (frame: BackendToRunner) => void,
  ): Promise<void>;

  // OAuth connect/callback lifecycle for connection-based integrations. Omitted for integrations
  // configured with plain fields (github) or backed by a per-participant identity (gmail).
  connection?: IntegrationConnection;
}
