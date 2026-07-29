import { Router } from "express";
import * as db from "../../db";
import * as auth from "../../auth";
import * as runners from "../../runners";
import { provisionerFor } from "../../provisioner";
import { listPendingConfirmsFor, resolveConfirmDecision } from "../../services/confirmations";
import * as agentAdmin from "../../services/agentAdmin";
import { wrap, ApiError } from "../errors";
import { optInt } from "../validate";
import { publicParticipant, requireAgent, requireRequester } from "../guards";

const router = Router();

// Create an agent = a participant of kind 'agent' running on the SDK runner. The logic lives in
// services/agentAdmin.ts (shared with the /mcp server); this route is the HTTP head. Allowed
// models / SDK permission modes live in @jungle/shared; keep the UI dropdown in sync.
router.post(
  "/api/agents",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const integrations = agentAdmin.validateIntegrations(req.body?.integrations);
    const participant = await agentAdmin.createAgentAs(me, {
      handle: req.body?.handle,
      displayName: req.body?.displayName,
      persona: req.body?.persona,
      model: req.body?.model ? String(req.body.model) : null,
      mode: req.body?.mode ? String(req.body.mode) : undefined,
      integrations: req.body?.integrations,
      runnerProvider: req.body?.runnerProvider ? String(req.body.runnerProvider) : undefined,
      hostId: req.body?.hostId ? String(req.body.hostId) : undefined,
    });
    // Respond immediately — provisioning (esp. a Fly machine's first boot / image pull) can take
    // up to ~1min, and the row + status UI ("waking"/"offline") already give the client what it needs.
    res.status(201).json({ ...publicParticipant(participant), integrations });
  }),
);

// Update an agent's config from its profile page. Auth-gated (any signed-in user). `mode` is
// pushed live to the runner (applies immediately); `model` applies at the next turn boundary.
// Logic in services/agentAdmin.ts (shared with the /mcp server).
router.patch(
  "/api/agents/:id",
  wrap(async (req, res) => {
    const { me, agent } = await requireAgent(req);
    const updated = await agentAdmin.updateAgentConfigAs(me, agent.id, {
      displayName: req.body?.displayName,
      persona: req.body?.persona,
      mode: req.body?.mode,
      model: req.body?.model,
      effort: req.body?.effort,
    });
    res.json(updated ? publicParticipant(updated) : updated);
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
// `onBehalfOf` (a participant id) only matters when the requester is an AGENT — an agent-bound API
// token attaching a connection-based integration names the person whose account backs it; a human
// always binds their own (integrations/backing.ts).
router.put(
  "/api/agents/:id/integrations/:key",
  wrap(async (req, res) => {
    const { me, agent } = await requireAgent(req);
    const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};
    const onBehalfOf = req.body?.onBehalfOf ? await db.getParticipant(String(req.body.onBehalfOf)) : null;
    res.json(await agentAdmin.attachIntegrationAs(me, agent.id, String(req.params.key), config, onBehalfOf));
  }),
);

router.delete(
  "/api/agents/:id/integrations/:key",
  wrap(async (req, res) => {
    const { me, agent } = await requireAgent(req);
    await agentAdmin.detachIntegrationAs(me, agent.id, String(req.params.key));
    res.json({ ok: true });
  }),
);

// Delete an agent entirely: tear down its runner + container/volume, then remove all of its data.
// Auth-gated (any signed-in user, matching PATCH). Logic in services/agentAdmin.ts.
router.delete(
  "/api/agents/:id",
  wrap(async (req, res) => {
    const { me, agent } = await requireAgent(req);
    await agentAdmin.deleteAgentAs(me, agent.id);
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
