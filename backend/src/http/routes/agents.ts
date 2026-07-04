import { Router } from "express";
import { randomBytes } from "node:crypto";
import { isAllowedEffort, isAllowedModel, isSdkMode } from "@jungle/shared";
import * as db from "../../db";
import * as auth from "../../auth";
import * as runners from "../../runners";
import { provisionerFor } from "../../provisioner";
import { broadcastWorkspace } from "../../ws/appSocket";
import { resolveConfirmDecision } from "../../services/confirmations";
import { wrap, ApiError } from "../errors";
import { optInt } from "../validate";
import { publicParticipant, requireAgent, requireRequester } from "../guards";

const router = Router();

// RUNNER_PROVIDER picks the default for newly-created agents until the Fly cutover; a per-request
// override lets a single test agent opt in early (see POST /api/agents).
const RUNNER_PROVIDER_DEFAULT = process.env.RUNNER_PROVIDER === "fly" ? "fly" : "docker";

// Create an agent = a participant of kind 'agent' running on the SDK runner: mint a per-agent
// runner token and provision its container. If `repo` ("owner/name") is given, the runner clones
// it and gets a fresh GitHub installation token in each `configure` (see runners.ts). Allowed
// models / SDK permission modes live in @jungle/shared; keep the UI dropdown in sync.
router.post(
  "/api/agents",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const { handle, displayName, repo } = req.body ?? {};
    if (!handle || !displayName) throw new ApiError(400, "handle, displayName required");
    const model = req.body?.model ? String(req.body.model) : null;
    if (model && !isAllowedModel(model)) throw new ApiError(400, `unsupported model: ${model}`);
    const mode = req.body?.mode ? String(req.body.mode) : "default";
    if (!isSdkMode(mode)) throw new ApiError(400, `unsupported mode: ${mode}`);
    const runnerToken = randomBytes(32).toString("hex");
    const runnerProvider = req.body?.runnerProvider === "fly" ? "fly" : RUNNER_PROVIDER_DEFAULT;
    // The agent joins the creator's workspace, subject to the workspace's agent cap. The cap check
    // + insert run in one transaction (FOR UPDATE on the workspace row) so concurrent creates can't
    // both slip past the limit.
    const participant = await db.withTransaction(async (client) => {
      const { count, cap } = await db.agentCountAndCap(client, me.workspace_id);
      if (count >= cap) throw new ApiError(409, `this workspace has reached its agent limit (${cap})`);
      return db.createParticipant({
        kind: "agent", workspaceId: me.workspace_id, handle, displayName, runtime: "sdk", runnerToken,
        repo: repo ?? null, model, mode, runnerProvider,
      }, client);
    });
    // Respond immediately — provisioning (esp. a Fly machine's first boot / image pull) can take
    // up to ~1min, and the row + status UI ("waking") already give the client what it needs.
    res.status(201).json(publicParticipant(participant));
    // Provision + start in the background. Best-effort: if the provisioner isn't available the
    // agent row still exists and a runner can be started later; just log the failure.
    void (async () => {
      try {
        await provisionerFor(participant).create({ id: participant.id, handle, runnerToken });
        await provisionerFor(participant).start(participant.id);
        runners.noteProvisionerStart(participant.id); // show "waking" until the runner connects
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
    const patch: { displayName?: string; mode?: string; model?: string; effort?: string } = {};
    if (req.body?.displayName !== undefined) {
      const dn = String(req.body.displayName).trim();
      if (!dn) throw new ApiError(400, "display name cannot be empty");
      patch.displayName = dn;
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
    const pub = updated ? publicParticipant(updated) : updated;
    broadcastWorkspace(agent.workspace_id, { type: "participant_updated", participant: pub });
    res.json(pub);
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
