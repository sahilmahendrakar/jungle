import type { GmailIntegrationConfig } from "@jungle/shared";
import { pool } from "./pool";

// An integration attached to an agent (see migrations/010_agent_integrations.sql). `config`
// holds whatever that integration type needs (github: `{repo: "owner/name"}`). This is the
// source of truth for what an agent can do — a blank chat agent simply has no rows here.
export interface AgentIntegrationRow {
  agent_id: string;
  integration_key: string;
  config: Record<string, unknown>;
}

export async function listAgentIntegrations(agentId: string): Promise<AgentIntegrationRow[]> {
  const { rows } = await pool.query<AgentIntegrationRow>(
    `select agent_id, integration_key, config from agent_integrations where agent_id = $1`,
    [agentId],
  );
  return rows;
}

export async function getAgentIntegration(
  agentId: string,
  key: string,
): Promise<AgentIntegrationRow | null> {
  const { rows } = await pool.query<AgentIntegrationRow>(
    `select agent_id, integration_key, config from agent_integrations
     where agent_id = $1 and integration_key = $2`,
    [agentId, key],
  );
  return rows[0] ?? null;
}

// Attach (or reconfigure) an integration on an agent.
export async function setAgentIntegration(
  agentId: string,
  key: string,
  config: Record<string, unknown>,
): Promise<AgentIntegrationRow> {
  const { rows } = await pool.query<AgentIntegrationRow>(
    `insert into agent_integrations (agent_id, integration_key, config)
     values ($1, $2, $3)
     on conflict (agent_id, integration_key) do update set config = excluded.config
     returning agent_id, integration_key, config`,
    [agentId, key, JSON.stringify(config)],
  );
  return rows[0];
}

export async function removeAgentIntegration(agentId: string, key: string): Promise<void> {
  await pool.query(
    `delete from agent_integrations where agent_id = $1 and integration_key = $2`,
    [agentId, key],
  );
}

// Convenience accessor for the one integration runners.ts currently acts on: the repo an
// agent's GitHub integration (if attached) is configured with.
export async function getAgentGithubRepo(agentId: string): Promise<string | null> {
  const row = await getAgentIntegration(agentId, "github");
  const repo = row?.config?.repo;
  return typeof repo === "string" && repo ? repo : null;
}

// The agent's attached Gmail integration config (if any): which connected account backs it and
// whether writes need approval. Secrets are NOT here (see google_identities). Returns null when
// no Gmail integration is attached or the row is malformed. Analogous to getAgentGithubRepo.
export async function getAgentGmail(agentId: string): Promise<GmailIntegrationConfig | null> {
  const row = await getAgentIntegration(agentId, "gmail");
  if (!row) return null;
  const c = row.config as Partial<GmailIntegrationConfig>;
  if (typeof c.backingParticipantId !== "string" || typeof c.email !== "string") return null;
  return {
    backingParticipantId: c.backingParticipantId,
    email: c.email,
    requireSendApproval: c.requireSendApproval !== false, // default on
  };
}
