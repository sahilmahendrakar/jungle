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
}
