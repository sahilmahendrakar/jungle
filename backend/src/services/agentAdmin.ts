import { randomBytes } from "node:crypto";
import {
  isAllowedEffort,
  isAllowedModel,
  isSdkMode,
  getIntegrationType,
  DEFAULT_AGENT_MODE,
  PERSONA_MAX_LENGTH,
  STATUS_TEXT_MAX_LENGTH,
  STATUS_EMOJI_MAX_LENGTH,
} from "@jungle/shared";
import type { AgentSelfStatus } from "@jungle/shared";
import { providerConfigured } from "../providers";
import * as db from "../db";
import * as runners from "../runners";
import { provisionerFor } from "../provisioner";
import { announceParticipant, broadcastWorkspace } from "../ws/appSocket";
import { adapterFor } from "../integrations";
import { syncRosterIntegration } from "./workflows";
import { ApiError } from "../http/errors";
import { publicParticipant, accountUid } from "../http/guards";

// Agent lifecycle/config with an explicit ACTOR — extracted from http/routes/agents.ts so the
// same logic serves the human REST routes and the /mcp server. Validation errors are ApiErrors;
// the MCP layer renders them as tool errors instead of HTTP statuses.

export const RUNNER_PROVIDER_DEFAULT = process.env.RUNNER_PROVIDER === "fly" ? "fly" : "docker";

// An agent is a blank chat agent by default: `integrations` (optional) attaches one or more
// integrations at creation time, e.g. [{key: "github", config: {repo: "owner/name"}}]. Unknown
// or comingSoon integration keys are rejected — only fully-wired-up types can actually be attached.
export function validateIntegrations(
  input: unknown,
): Array<{ key: string; config: Record<string, unknown> }> {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new ApiError(400, "integrations must be an array");
  return input.map((entry) => {
    const key = String(entry?.key ?? "");
    const type = getIntegrationType(key);
    if (!type || type.comingSoon) throw new ApiError(400, `unsupported integration: ${key}`);
    const config = entry?.config && typeof entry.config === "object" ? entry.config : {};
    return { key, config };
  });
}

// Resolve the config actually persisted for an integration the actor is attaching. Most
// integrations store the supplied config as-is; connection-based ones (gmail, …) normalize it via
// their adapter's resolveConfig — e.g. gmail binds to the actor's connected Google account and
// drops secrets. Per-service logic lives in backend/src/integrations/, not here.
// `onBehalfOf` names the person whose connection should back it when the ACTOR is an agent (which
// has none of its own) — see integrations/backing.ts.
export async function resolveIntegrationConfig(
  actor: db.Participant,
  agentId: string,
  key: string,
  rawConfig: Record<string, unknown>,
  onBehalfOf?: db.Participant | null,
): Promise<Record<string, unknown>> {
  const adapter = adapterFor(key);
  if (!adapter?.resolveConfig) return rawConfig;
  const existing = await db.getAgentIntegration(agentId, key);
  return adapter.resolveConfig(
    { me: actor, agentId, existing: existing?.config ?? null, onBehalfOf: onBehalfOf ?? null },
    rawConfig,
  );
}

// @jungle is the workspace's default agent (services/jungleAgent.ts): it's part of the product,
// not something a member added, so it can't be renamed or deleted out from under everyone. Its
// persona/model/mode stay editable — only identity and existence are fixed.
const guardDefaultAgent = (agent: db.Participant, what: string): void => {
  if (!agent.jungle_default) return;
  throw new ApiError(400, `@${agent.handle} is this workspace's default agent and can't be ${what}`);
};

const validatedPersona = (raw: unknown): string | null => {
  const persona = String(raw ?? "").trim() || null;
  if (persona && persona.length > PERSONA_MAX_LENGTH) {
    throw new ApiError(400, `instructions must be at most ${PERSONA_MAX_LENGTH} characters`);
  }
  return persona;
};

// Create an agent = a participant of kind 'agent' running on the SDK runner: mint a per-agent
// runner token and provision its container. Extracted from POST /api/agents; see that route's
// comments for the model/mode/provider details. Returns the created row (already broadcast-safe
// via publicParticipant is the caller's job — this returns the full row).
export async function createAgentAs(
  actor: db.Participant,
  input: {
    handle: string;
    displayName: string;
    persona?: unknown;
    model?: string | null;
    mode?: string;
    integrations?: unknown;
    runnerProvider?: string;
    hostId?: string;
    // Whose connected accounts back the connection-based integrations attached here (only
    // meaningful when the actor is an agent) — see integrations/backing.ts.
    onBehalfOf?: db.Participant | null;
  },
): Promise<db.Participant> {
  const { handle, displayName } = input;
  if (!handle || !displayName) throw new ApiError(400, "handle, displayName required");
  // Reserved handles (@jungle) are refused here too, not just on the human sign-up paths: this is
  // how agents create agents (mcp/tools.ts create_agent), and an agent naming one "jungle" in a
  // workspace whose default agent doesn't exist yet would take the handle people @-mention.
  if (!(await db.handleAvailable(actor.workspace_id, handle))) {
    throw new ApiError(409, `@${handle} is taken in this workspace`);
  }
  const persona = input.persona !== undefined ? validatedPersona(input.persona) : null;
  const model = input.model ? String(input.model) : null;
  if (model && !isAllowedModel(model)) throw new ApiError(400, `unsupported model: ${model}`);
  if (model && !providerConfigured(model)) {
    throw new ApiError(400, `model unavailable: ${model}'s provider API key is not configured`);
  }
  const mode = input.mode ? String(input.mode) : DEFAULT_AGENT_MODE;
  if (!isSdkMode(mode)) throw new ApiError(400, `unsupported mode: ${mode}`);
  const integrations = validateIntegrations(input.integrations);
  const runnerToken = randomBytes(32).toString("hex");
  // Environment: cloud default, 'fly' opt-in, or 'self_hosted' bound to one of the actor's
  // registered devices (must be assignable — their own device, or one shared into this workspace).
  let runnerProvider = RUNNER_PROVIDER_DEFAULT;
  let hostId: string | null = null;
  if (input.runnerProvider === "fly") {
    runnerProvider = "fly";
  } else if (input.runnerProvider === "self_hosted") {
    runnerProvider = "self_hosted";
    hostId = String(input.hostId ?? "");
    if (!hostId) throw new ApiError(400, "hostId is required for a self-hosted agent");
    if (!(await db.canAssignHost(hostId, accountUid(actor), actor.workspace_id))) {
      throw new ApiError(403, "you don't have access to run agents on that device");
    }
  }
  // The agent joins the actor's workspace, subject to the workspace's agent cap. The cap check
  // + insert run in one transaction (FOR UPDATE on the workspace row) so concurrent creates can't
  // both slip past the limit.
  const participant = await db.withTransaction(async (client) => {
    const { count, cap } = await db.agentCountAndCap(client, actor.workspace_id);
    if (count >= cap) throw new ApiError(409, `this workspace has reached its agent limit (${cap})`);
    return db.createParticipant({
      kind: "agent", workspaceId: actor.workspace_id, handle, displayName, runtime: "sdk", runnerToken,
      model, mode, runnerProvider, persona, createdBy: actor.id,
    }, client);
  });
  // Bind the agent to its device before provisioning reads runner_meta.hostId.
  if (hostId) await db.setRunnerMeta(participant.id, { hostId });
  // Attach the requested integrations, or undo the whole create. An integration that can't be
  // resolved (e.g. nobody has connected Notion yet) used to throw with the row already inserted,
  // leaving a half-made agent: it exists, has no integrations, and — because the throw happens
  // before the block below — was never provisioned, so it can never come online. Callers retrying
  // then hit "handle already taken". All-or-nothing instead: the caller fixes the integration and
  // creates again.
  try {
    for (const { key, config } of integrations) {
      const resolved = await resolveIntegrationConfig(actor, participant.id, key, config, input.onBehalfOf);
      await db.setAgentIntegration(participant.id, key, resolved);
    }
  } catch (e) {
    await db.deleteAgent(participant.id).catch((err) => console.error("rollback of half-created agent:", err));
    throw e;
  }
  if (hostId) participant.runner_meta = { hostId };
  // Put the new agent in everyone's roster now (Team page, member pickers, @-autocomplete) —
  // the mirror of the participant_deleted broadcast below.
  announceParticipant(participant);
  // Provision + start in the background. Best-effort: if the provisioner isn't available the
  // agent row still exists and a runner can be started later; just log the failure. For
  // self-hosted, start() sends a run command to the device (no-op if it's offline — the agent
  // shows `offline` until the daemon reconnects), and we only show "waking" if the device is up.
  void (async () => {
    try {
      await provisionerFor(participant).create({ id: participant.id, handle, runnerToken });
      await provisionerFor(participant).start(participant.id);
      if (runnerProvider !== "self_hosted" || runners.isAgentDeviceOnline(participant.id)) {
        runners.noteProvisionerStart(participant.id); // show "waking" until the runner connects
      }
    } catch (e) {
      console.error("provisioner create/start:", e);
    }
  })();
  return participant;
}

// Guard: `agentId` names an agent in the actor's workspace. Mirrors guards.requireAgent but by
// actor instead of an express request.
export async function requireAgentInWorkspace(
  actor: db.Participant,
  agentId: string,
): Promise<db.Participant> {
  const agent = await db.getParticipant(String(agentId));
  if (!agent || agent.kind !== "agent" || agent.workspace_id !== actor.workspace_id) {
    throw new ApiError(404, "agent not found");
  }
  return agent;
}

// Update an agent's config. Extracted from PATCH /api/agents/:id: `mode`/`effort` are pushed
// live to the runner (apply immediately); `model` applies at the next turn boundary;
// persona/displayName reach the runner via a fresh `configure`.
export async function updateAgentConfigAs(
  actor: db.Participant,
  agentId: string,
  input: { displayName?: unknown; persona?: unknown; mode?: unknown; model?: unknown; effort?: unknown },
): Promise<db.Participant | null> {
  const agent = await requireAgentInWorkspace(actor, agentId);
  const patch: {
    displayName?: string;
    mode?: string;
    model?: string;
    effort?: string;
    persona?: string | null;
  } = {};
  if (input.displayName !== undefined) {
    const dn = String(input.displayName).trim();
    if (!dn) throw new ApiError(400, "display name cannot be empty");
    if (dn !== agent.display_name) guardDefaultAgent(agent, "renamed");
    patch.displayName = dn;
  }
  if (input.persona !== undefined) {
    patch.persona = validatedPersona(input.persona); // empty clears it
  }
  if (input.mode !== undefined) {
    const mode = String(input.mode);
    if (!isSdkMode(mode)) throw new ApiError(400, `unsupported mode: ${mode}`);
    if (mode !== agent.mode) runners.setPermissionMode(agent.id, mode);
    patch.mode = mode;
  }
  if (input.model !== undefined) {
    const model = String(input.model);
    if (!isAllowedModel(model)) throw new ApiError(400, `unsupported model: ${model}`);
    if (!providerConfigured(model)) {
      throw new ApiError(400, `model unavailable: ${model}'s provider API key is not configured`);
    }
    if (model !== agent.model) runners.setModel(agent.id, model);
    patch.model = model;
  }
  if (input.effort !== undefined) {
    const effort = String(input.effort);
    if (!isAllowedEffort(effort)) throw new ApiError(400, `unsupported effort: ${effort}`);
    if (effort !== agent.effort) runners.setEffort(agent.id, effort);
    patch.effort = effort;
  }
  const updated = await db.updateAgentConfig(agent.id, patch);
  // Persona/display name live in the system prompt, which the runner only receives via
  // `configure` — push a fresh one so a long-connected runner picks the edit up at its next
  // turn instead of waiting for a reconnect.
  if (updated && (patch.persona !== undefined || patch.displayName !== undefined)) {
    await runners.reconfigure(agent.id);
  }
  broadcastWorkspace(agent.workspace_id, {
    type: "participant_updated",
    participant: updated ? publicParticipant(updated) : updated,
  });
  return updated;
}

// Attach (or reconfigure) one integration on an agent. `config` must match that integration
// type's configFields (e.g. github: {repo: "owner/name"}) — validated only for presence here;
// the integration itself (e.g. installationTokenForRepo) surfaces a bad value at connect time.
// Extracted from PUT /api/agents/:id/integrations/:key.
export async function attachIntegrationAs(
  actor: db.Participant,
  agentId: string,
  key: string,
  config: Record<string, unknown>,
  onBehalfOf?: db.Participant | null,
): Promise<db.AgentIntegrationRow> {
  const agent = await requireAgentInWorkspace(actor, agentId);
  const type = getIntegrationType(key);
  if (!type || type.comingSoon) throw new ApiError(400, `unsupported integration: ${key}`);
  for (const field of type.configFields) {
    if (!config[field.key]) throw new ApiError(400, `${field.label} is required`);
  }
  const resolved = await resolveIntegrationConfig(actor, agent.id, key, config, onBehalfOf);
  const row = await db.setAgentIntegration(agent.id, key, resolved);
  // Integration grants (git creds, MCP servers, prompt blocks) only reach the runner via
  // `configure` — push a fresh one so a connected runner picks the change up at its next turn
  // instead of silently keeping the old grants until a reconnect. No-op when offline.
  await runners.reconfigure(agent.id);
  // Roster seats advertise the agent's integrations (canvas chips + Connections panel) —
  // add the key everywhere this agent sits so those views follow the attach.
  await syncRosterIntegration(agent.id, key, "attach", resolved);
  return row;
}

// Detach one integration. Extracted from DELETE /api/agents/:id/integrations/:key. The adapter's
// optional onDetach hook lets an integration revoke anything it minted (e.g. jungle's API token).
export async function detachIntegrationAs(
  actor: db.Participant,
  agentId: string,
  key: string,
): Promise<void> {
  const agent = await requireAgentInWorkspace(actor, agentId);
  await db.removeAgentIntegration(agent.id, key);
  await adapterFor(key)?.onDetach?.(agent);
  // Revoke the grant on a live runner too (same reasoning as the attach above).
  await runners.reconfigure(agent.id);
  // …and scrub the key from the agent's roster seats (mirror of the attach's sync).
  await syncRosterIntegration(agent.id, key, "detach");
}

// --- Self-set status (the Slack-style "what I'm working on" line) ---

// Validate + persist an agent's status and broadcast the updated participant. The ONE writer:
// both the agent's set_status tool (via the orchestrator's runner hook) and a human hitting Clear
// on the profile land here, so validation, the broadcast, and the runner push can't get out of
// step between the two paths.
//
// `notifyRunner` distinguishes them. When the agent set it, its tool result already carries the
// stored status, so pushing status_changed back would be a redundant round trip. When a HUMAN
// cleared it, the runner's cached copy is now wrong and must be corrected — otherwise the agent
// keeps being shown a status nobody else can see.
export async function writeAgentStatus(
  agentId: string,
  workspaceId: string,
  input: { text?: string | null; emoji?: string; clearAfterMinutes?: number },
  opts: { notifyRunner: boolean },
): Promise<AgentSelfStatus | null> {
  // Empty/whitespace text clears — the tool has no separate clear verb on purpose.
  const raw = input.text == null ? "" : String(input.text).trim();
  if (raw.length > STATUS_TEXT_MAX_LENGTH) {
    throw new ApiError(400, `status must be ${STATUS_TEXT_MAX_LENGTH} characters or fewer`);
  }
  const emoji = String(input.emoji ?? "").trim();
  if (emoji.length > STATUS_EMOJI_MAX_LENGTH) {
    throw new ApiError(400, `status emoji must be ${STATUS_EMOJI_MAX_LENGTH} characters or fewer`);
  }
  // A "clear after" in the past (or absurdly far out) would either hide the status instantly or
  // amount to no expiry at all; both are more surprising than refusing.
  let expiresAt: Date | null = null;
  if (raw && input.clearAfterMinutes != null) {
    const mins = Number(input.clearAfterMinutes);
    if (!Number.isFinite(mins) || mins <= 0 || mins > 60 * 24 * 30) {
      throw new ApiError(400, "clearAfterMinutes must be between 1 and 43200 (30 days)");
    }
    expiresAt = new Date(Date.now() + mins * 60_000);
  }
  const updated = await db.setAgentStatus(agentId, {
    text: raw || null,
    emoji: emoji || null,
    expiresAt,
  });
  if (!updated) throw new ApiError(404, "agent not found");
  const status = db.selfStatusOf(updated);
  broadcastWorkspace(workspaceId, {
    type: "participant_updated",
    participant: publicParticipant(updated),
  });
  if (opts.notifyRunner) runners.pushSelfStatus(agentId, status);
  return status;
}

// Delete an agent entirely: tear down its runner + container/volume, then remove all of its data.
// Extracted from DELETE /api/agents/:id. Best-effort on container teardown so a docker hiccup
// doesn't strand the DB row; the DB delete is the source of truth.
export async function deleteAgentAs(actor: db.Participant, agentId: string): Promise<void> {
  const agent = await requireAgentInWorkspace(actor, agentId);
  guardDefaultAgent(agent, "deleted");
  // Stop the runner working and close its socket so it can't reconnect mid-teardown.
  runners.disconnect(agent.id);
  try {
    await provisionerFor(agent).destroy(agent.id);
  } catch (e) {
    console.error("provisioner destroy:", e);
  }
  await db.deleteAgent(agent.id);
  broadcastWorkspace(agent.workspace_id, { type: "participant_deleted", participantId: agent.id });
}
