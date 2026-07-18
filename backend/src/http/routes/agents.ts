import { Router } from "express";
import { randomBytes } from "node:crypto";
import {
  isAllowedEffort,
  isAllowedModel,
  isSdkMode,
  getIntegrationType,
  PERSONA_MAX_LENGTH,
} from "@jungle/shared";
import { providerConfigured } from "../../providers";
import * as db from "../../db";
import * as auth from "../../auth";
import * as runners from "../../runners";
import { provisionerFor } from "../../provisioner";
import { broadcastWorkspace } from "../../ws/appSocket";
import { listPendingConfirmsFor, resolveConfirmDecision } from "../../services/confirmations";
import * as workflows from "../../services/workflows";
import { wrap, ApiError } from "../errors";
import { optInt } from "../validate";
import { publicParticipant, requireAgent, requireRequester, accountUid } from "../guards";
import { adapterFor } from "../../integrations";

const router = Router();

// RUNNER_PROVIDER picks the default for newly-created agents until the Fly cutover; a per-request
// override lets a single test agent opt in early (see POST /api/agents).
const RUNNER_PROVIDER_DEFAULT = process.env.RUNNER_PROVIDER === "fly" ? "fly" : "docker";

// An agent is a blank chat agent by default: `integrations` (optional) attaches one or more
// integrations at creation time, e.g. [{key: "github", config: {repo: "owner/name"}}]. Unknown
// or comingSoon integration keys are rejected — only fully-wired-up types can actually be attached.
function validateIntegrations(
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

// Resolve the config actually persisted for an integration the requester is attaching. Most
// integrations store the client-supplied config as-is; connection-based ones (gmail, …) normalize
// it via their adapter's resolveConfig — e.g. gmail binds to the requester's connected Google
// account and drops secrets. Per-service logic lives in backend/src/integrations/, not here.
async function resolveIntegrationConfig(
  me: db.Participant,
  agentId: string,
  key: string,
  rawConfig: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const adapter = adapterFor(key);
  if (!adapter?.resolveConfig) return rawConfig;
  const existing = await db.getAgentIntegration(agentId, key);
  return adapter.resolveConfig({ me, agentId, existing: existing?.config ?? null }, rawConfig);
}

// Create an agent = a participant of kind 'agent' running on the SDK runner: mint a per-agent
// runner token and provision its container. It starts as a blank chat agent; `integrations`
// (optional) attaches integrations like GitHub (see validateIntegrations above and
// backend/src/db/integrations.ts) — the runner then gets whatever that integration grants
// (git credentials, MCP servers, ...) in each `configure` (see runners.ts). Allowed models / SDK
// permission modes live in @jungle/shared; keep the UI dropdown in sync.
router.post(
  "/api/agents",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const { handle, displayName } = req.body ?? {};
    if (!handle || !displayName) throw new ApiError(400, "handle, displayName required");
    // Optional creator-written instructions/persona, injected into the agent's system prompt. Same
    // length cap as the profile-page edit; empty string clears it (stored as null).
    let persona: string | null = null;
    if (req.body?.persona !== undefined) {
      persona = String(req.body.persona ?? "").trim() || null;
      if (persona && persona.length > PERSONA_MAX_LENGTH) {
        throw new ApiError(400, `instructions must be at most ${PERSONA_MAX_LENGTH} characters`);
      }
    }
    const model = req.body?.model ? String(req.body.model) : null;
    if (model && !isAllowedModel(model)) throw new ApiError(400, `unsupported model: ${model}`);
    if (model && !providerConfigured(model)) {
      throw new ApiError(400, `model unavailable: ${model}'s provider API key is not configured`);
    }
    const mode = req.body?.mode ? String(req.body.mode) : "default";
    if (!isSdkMode(mode)) throw new ApiError(400, `unsupported mode: ${mode}`);
    const integrations = validateIntegrations(req.body?.integrations);
    const runnerToken = randomBytes(32).toString("hex");
    // Environment: cloud default, 'fly' opt-in, or 'self_hosted' bound to one of the requester's
    // registered devices (must be assignable — their own device, or one shared into this workspace).
    let runnerProvider = RUNNER_PROVIDER_DEFAULT;
    let hostId: string | null = null;
    if (req.body?.runnerProvider === "fly") {
      runnerProvider = "fly";
    } else if (req.body?.runnerProvider === "self_hosted") {
      runnerProvider = "self_hosted";
      hostId = String(req.body?.hostId ?? "");
      if (!hostId) throw new ApiError(400, "hostId is required for a self-hosted agent");
      if (!(await db.canAssignHost(hostId, accountUid(me), me.workspace_id))) {
        throw new ApiError(403, "you don't have access to run agents on that device");
      }
    }
    // The agent joins the creator's workspace, subject to the workspace's agent cap. The cap check
    // + insert run in one transaction (FOR UPDATE on the workspace row) so concurrent creates can't
    // both slip past the limit.
    const participant = await db.withTransaction(async (client) => {
      const { count, cap } = await db.agentCountAndCap(client, me.workspace_id);
      if (count >= cap) throw new ApiError(409, `this workspace has reached its agent limit (${cap})`);
      return db.createParticipant({
        kind: "agent", workspaceId: me.workspace_id, handle, displayName, runtime: "sdk", runnerToken,
        model, mode, runnerProvider, persona,
      }, client);
    });
    // Bind the agent to its device before provisioning reads runner_meta.hostId.
    if (hostId) await db.setRunnerMeta(participant.id, { hostId });
    for (const { key, config } of integrations) {
      await db.setAgentIntegration(participant.id, key, await resolveIntegrationConfig(me, participant.id, key, config));
    }
    // Respond immediately — provisioning (esp. a Fly machine's first boot / image pull) can take
    // up to ~1min, and the row + status UI ("waking"/"offline") already give the client what it needs.
    const runnerMeta = hostId ? { hostId } : participant.runner_meta;
    res.status(201).json({ ...publicParticipant({ ...participant, runner_meta: runnerMeta }), integrations });
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
  }),
);

// Update an agent's config from its profile page. Auth-gated (any signed-in user). `mode` is
// pushed live to the runner (applies immediately); `model` applies at the next turn boundary.
router.patch(
  "/api/agents/:id",
  wrap(async (req, res) => {
    const { agent } = await requireAgent(req);
    const patch: {
      displayName?: string;
      mode?: string;
      model?: string;
      effort?: string;
      persona?: string | null;
    } = {};
    if (req.body?.displayName !== undefined) {
      const dn = String(req.body.displayName).trim();
      if (!dn) throw new ApiError(400, "display name cannot be empty");
      patch.displayName = dn;
    }
    if (req.body?.persona !== undefined) {
      const persona = String(req.body.persona ?? "").trim();
      if (persona.length > PERSONA_MAX_LENGTH) {
        throw new ApiError(400, `persona must be at most ${PERSONA_MAX_LENGTH} characters`);
      }
      patch.persona = persona || null; // empty clears it
    }
    if (req.body?.mode !== undefined) {
      const mode = String(req.body.mode);
      if (!isSdkMode(mode)) throw new ApiError(400, `unsupported mode: ${mode}`);
      if (mode !== agent.mode) runners.setPermissionMode(agent.id, mode);
      patch.mode = mode;
    }
    if (req.body?.model !== undefined) {
      const model = String(req.body.model);
      if (!isAllowedModel(model)) throw new ApiError(400, `unsupported model: ${model}`);
      if (!providerConfigured(model)) {
        throw new ApiError(400, `model unavailable: ${model}'s provider API key is not configured`);
      }
      if (model !== agent.model) runners.setModel(agent.id, model);
      patch.model = model;
    }
    if (req.body?.effort !== undefined) {
      const effort = String(req.body.effort);
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
    const pub = updated ? publicParticipant(updated) : updated;
    broadcastWorkspace(agent.workspace_id, { type: "participant_updated", participant: pub });
    res.json(pub);
  }),
);

// This agent's attached integrations (github's repo, etc.) — the settings page's integrations list.
router.get(
  "/api/agents/:id/integrations",
  wrap(async (req, res) => {
    const { agent } = await requireAgent(req);
    res.json(await db.listAgentIntegrations(agent.id));
  }),
);

// Attach (or reconfigure) one integration on an agent. `config` must match that integration
// type's configFields (e.g. github: {repo: "owner/name"}) — validated only for presence here;
// the integration itself (e.g. installationTokenForRepo) surfaces a bad value at connect time.
router.put(
  "/api/agents/:id/integrations/:key",
  wrap(async (req, res) => {
    const { me, agent } = await requireAgent(req);
    const key = String(req.params.key);
    const type = getIntegrationType(key);
    if (!type || type.comingSoon) throw new ApiError(400, `unsupported integration: ${key}`);
    const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};
    for (const field of type.configFields) {
      if (!config[field.key]) throw new ApiError(400, `${field.label} is required`);
    }
    const resolved = await resolveIntegrationConfig(me, agent.id, key, config);
    const row = await db.setAgentIntegration(agent.id, key, resolved);
    // Integration grants (git creds, MCP servers, prompt blocks) only reach the runner via
    // `configure` — push a fresh one so a connected runner picks the change up at its next turn
    // instead of silently keeping the old grants until a reconnect. No-op when offline.
    await runners.reconfigure(agent.id);
    // Roster seats advertise the agent's integrations (canvas chips + Connections panel) —
    // add the key everywhere this agent sits so those views follow the attach.
    await workflows.syncRosterIntegration(agent.id, key, "attach", resolved);
    res.json(row);
  }),
);

router.delete(
  "/api/agents/:id/integrations/:key",
  wrap(async (req, res) => {
    const { agent } = await requireAgent(req);
    const key = String(req.params.key);
    await db.removeAgentIntegration(agent.id, key);
    // Revoke the grant on a live runner too (same reasoning as the PUT above).
    await runners.reconfigure(agent.id);
    // …and scrub the key from the agent's roster seats (mirror of the PUT's sync).
    await workflows.syncRosterIntegration(agent.id, key, "detach");
    res.json({ ok: true });
  }),
);

// Delete an agent entirely: tear down its runner + container/volume, then remove all of its data.
// Auth-gated (any signed-in user, matching PATCH). Best-effort on container teardown so a docker
// hiccup doesn't strand the DB row; the DB delete is the source of truth.
router.delete(
  "/api/agents/:id",
  wrap(async (req, res) => {
    const { agent } = await requireAgent(req);
    // Stop the runner working and close its socket so it can't reconnect mid-teardown.
    runners.disconnect(agent.id);
    // Remove the container + its workspace volume. Best-effort: log but don't fail the request.
    try {
      await provisionerFor(agent).destroy(agent.id);
    } catch (e) {
      console.error("provisioner destroy:", e);
    }
    await db.deleteAgent(agent.id);
    broadcastWorkspace(agent.workspace_id, { type: "participant_deleted", participantId: agent.id });
    res.json({ ok: true });
  }),
);

// The agent's curated long-term memory (its /workspace/MEMORY.md, mirrored to the DB via the
// runner's `memory` frame) — the profile panel's read-only Memory section. Served on demand
// rather than riding in participant payloads (publicParticipant strips it: it can be ~12KB).
router.get(
  "/api/agents/:id/memory",
  wrap(async (req, res) => {
    const { agent } = await requireAgent(req);
    const row = await db.getAgentMemory(agent.id);
    res.json({ memory: row?.memory ?? null, updatedAt: row?.memory_updated_at ?? null });
  }),
);

// The agent's managed services (service_* tools: dev servers, watchers), as last reported by
// its runner — the profile panel's Services section. On-demand like memory; live updates are
// signalled by agent_services_changed broadcasts.
router.get(
  "/api/agents/:id/services",
  wrap(async (req, res) => {
    const { agent } = await requireAgent(req);
    const { services, updatedAt } = await db.getAgentServices(agent.id);
    res.json({ services, updatedAt });
  }),
);

// Stop one of the agent's managed services (the profile panel's stop button). Forwards a
// service_stop frame to the connected runner; the runner kills the process group and reports
// the fresh list (which lands as an agent_services_changed broadcast).
router.post(
  "/api/agents/:id/services/:name/stop",
  wrap(async (req, res) => {
    const { agent } = await requireAgent(req);
    const name = String(req.params.name ?? "");
    if (!runners.stopService(agent.id, name)) {
      throw new ApiError(409, "agent is not connected — nothing to stop right now");
    }
    res.json({ ok: true });
  }),
);

// Activity feed history for an sdk agent: persisted SDK stream events, oldest-first within the
// returned page. Live updates ride the app WS as `agent_event` broadcasts.
router.get(
  "/api/agents/:id/events",
  wrap(async (req, res) => {
    const { agent } = await requireAgent(req);
    // Guard against NaN (e.g. ?before=abc) reaching the bigint bind / limit clamp.
    const before = optInt(req.query.before);
    const limit = optInt(req.query.limit);
    const rows = await db.listAgentEvents(agent.id, { before, limit });
    rows.reverse(); // newest-first from the DB -> oldest-first for rendering
    res.json({ events: rows, runner: runners.runnerState(agent.id) });
  }),
);

// Dev-only: simulate the idle-stop sweeper / wake-on-message so the "sleeping"/"waking" statuses
// can be exercised end-to-end. 404 in production (DEV_BYPASS off) so they never exist there.
router.post(
  "/api/agents/:id/_test/sleep",
  wrap(async (req, res) => {
    if (!auth.DEV_BYPASS) return res.status(404).end();
    const agent = await db.getParticipant(String(req.params.id));
    if (!agent || agent.kind !== "agent") throw new ApiError(404, "agent not found");
    await provisionerFor(agent).stop(agent.id);
    runners.noteProvisionerStop(agent.id);
    res.json({ ok: true, status: runners.agentStatus(agent.id) });
  }),
);
router.post(
  "/api/agents/:id/_test/wake",
  wrap(async (req, res) => {
    if (!auth.DEV_BYPASS) return res.status(404).end();
    const agent = await db.getParticipant(String(req.params.id));
    if (!agent || agent.kind !== "agent") throw new ApiError(404, "agent not found");
    await provisionerFor(agent).start(agent.id);
    runners.noteProvisionerStart(agent.id);
    res.json({ ok: true, status: runners.agentStatus(agent.id) });
  }),
);

// Interrupt an sdk agent's running turn (the Activity pane's Stop button). Queued messages are
// not discarded — they're consumed at the next turn boundary.
router.post(
  "/api/agents/:id/interrupt",
  wrap(async (req, res) => {
    const { agent } = await requireAgent(req);
    const delivered = runners.interrupt(agent.id);
    res.json({ ok: delivered, ...(delivered ? {} : { error: "runner not connected" }) });
  }),
);

// Ask an sdk agent to compact/summarize its session context (the profile's Compact button).
// A sleeping/waking agent has no runner connected to compact yet — rather than failing with
// "offline", wake its machine and deliver the compact once its runner says `hello`.
router.post(
  "/api/agents/:id/compact",
  wrap(async (req, res) => {
    const { agent } = await requireAgent(req);
    const result = await runners.compactOrWake(agent);
    if (result === "wake_failed") return res.json({ ok: false, error: "failed to wake agent" });
    res.json({ ok: true, waking: result === "waking" });
  }),
);

// Ask an sdk agent to clear its conversation/context window (the profile's Clear button —
// Claude Code's `/clear`). The runner drops the session at the next idle boundary; memory
// files are untouched. Same wake-if-asleep path as compact.
router.post(
  "/api/agents/:id/clear",
  wrap(async (req, res) => {
    const { agent } = await requireAgent(req);
    const result = await runners.clearContextOrWake(agent);
    if (result === "wake_failed") return res.json({ ok: false, error: "failed to wake agent" });
    res.json({ ok: true, waking: result === "waking" });
  }),
);

// Every confirmation still awaiting a decision that the requester can act on (member of the
// confirm's channel). Clients call this on load/reconnect to rebuild the approvals badge/inbox —
// the request-time WS fan-out only reaches sockets that were open at that moment.
router.get(
  "/api/confirmations",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    res.json({ confirmations: await listPendingConfirmsFor(me.id) });
  }),
);

// Approve/deny a pending tool confirmation card. Resolving here fulfils the promise runners.ts is
// awaiting for that confirm, which then relays the decision to the runner as a confirm_result.
router.post(
  "/api/agents/confirm",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const confirmId = String(req.body?.confirmId ?? "");
    const decision = req.body?.decision === "allow" ? "allow" : "deny";
    await resolveConfirmDecision(confirmId, decision, me);
    res.json({ ok: true });
  }),
);

export default router;
