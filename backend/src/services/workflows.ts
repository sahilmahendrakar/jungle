import { randomBytes } from "node:crypto";
import {
  MAX_WORKFLOWS_PER_WORKSPACE,
  WORKFLOW_MAX_ROLES,
  WORKFLOW_NAME_MAX_LENGTH,
  WORKFLOW_PLAYBOOK_MAX_LENGTH,
  getWorkflowTemplate,
  rosterIntegrationSettings,
  type WorkflowRole,
  type WorkflowTrigger,
} from "@jungle/shared";
import * as db from "../db";
import * as att from "../attachments";
import * as runners from "../runners";
import { provisionerFor } from "../provisioner";
import { broadcastWorkspace, fanOut, DEFAULT_CASCADE_BUDGET } from "../ws/appSocket";
import { ApiError } from "../http/errors";
import { isValidTimeZone, computeNextRun } from "./scheduler";

// Workflows: validation + lifecycle. Phase 0 covers drafts (create from template/blank, edit,
// delete); finalize + run lifecycle land next (see shared/docs/workflows-plan.md). Everything a
// workflow does at runtime compiles down to existing primitives — this module never invents a
// second dispatch path.

// --- Validation ---

export function validateTrigger(t: unknown): WorkflowTrigger {
  const trig = (t ?? { type: "manual" }) as WorkflowTrigger;
  if (trig.type === "manual" || trig.type === "channel_message") return { type: trig.type };
  if (trig.type === "schedule") {
    if (!trig.cron || typeof trig.cron !== "string") throw new ApiError(400, "schedule trigger needs a cron expression");
    if (!trig.timezone || !isValidTimeZone(trig.timezone)) {
      throw new ApiError(400, `schedule trigger needs a valid IANA timezone (got ${JSON.stringify(trig.timezone ?? null)})`);
    }
    try {
      computeNextRun(trig.cron, trig.timezone);
    } catch {
      throw new ApiError(400, `invalid cron expression ${JSON.stringify(trig.cron)} (expected 5-field cron)`);
    }
    return { type: "schedule", cron: trig.cron, timezone: trig.timezone };
  }
  throw new ApiError(400, `unknown trigger type ${JSON.stringify((trig as { type?: unknown }).type ?? null)}`);
}

export function validateRoster(r: unknown): WorkflowRole[] {
  if (!Array.isArray(r)) throw new ApiError(400, "roster must be an array of roles");
  if (r.length > WORKFLOW_MAX_ROLES) throw new ApiError(400, `at most ${WORKFLOW_MAX_ROLES} roles per workflow`);
  return r.map((raw, i) => {
    const role = raw as Partial<WorkflowRole>;
    if (!role.role || typeof role.role !== "string") throw new ApiError(400, `roster[${i}]: role name is required`);
    if (!role.handle_seed || typeof role.handle_seed !== "string") throw new ApiError(400, `roster[${i}]: handle_seed is required`);
    return {
      role: role.role.trim().slice(0, 80),
      ...(role.name && typeof role.name === "string" ? { name: role.name.trim().slice(0, 80) } : {}),
      handle_seed: role.handle_seed.trim().toLowerCase().slice(0, 48),
      duties: typeof role.duties === "string" ? role.duties.slice(0, 2000) : "",
      integrations: Array.isArray(role.integrations) ? role.integrations.filter((k) => typeof k === "string") : [],
      ...(role.repo && typeof role.repo === "string" ? { repo: role.repo.trim().slice(0, 200) } : {}),
      ...(role.participant_id ? { participant_id: String(role.participant_id) } : {}),
      // Canvas layout hints (presentation only — see shared/src/workflows.ts).
      ...(typeof role.stage === "number" && role.stage > 0
        ? { stage: Math.min(Math.floor(role.stage), WORKFLOW_MAX_ROLES) }
        : {}),
      ...(role.edge_label && typeof role.edge_label === "string"
        ? { edge_label: role.edge_label.trim().slice(0, 40) }
        : {}),
    };
  });
}

export function validateName(name: unknown): string {
  const n = String(name ?? "").trim();
  if (!n) throw new ApiError(400, "name is required");
  if (n.length > WORKFLOW_NAME_MAX_LENGTH) throw new ApiError(400, `name too long (max ${WORKFLOW_NAME_MAX_LENGTH} chars)`);
  return n;
}

export function validatePlaybook(p: unknown): string {
  const s = String(p ?? "");
  if (s.length > WORKFLOW_PLAYBOOK_MAX_LENGTH) {
    throw new ApiError(400, `playbook too long (max ${WORKFLOW_PLAYBOOK_MAX_LENGTH} chars)`);
  }
  return s;
}

// --- Draft creation (from a template or blank) ---

export async function createDraft(args: {
  workspaceId: string;
  createdBy: string | null;
  templateId?: string;
  name?: string;
  // When set (the builder/HTTP path), template seats become real unprovisioned agents right
  // away so the builder can open real profile panels on them. The Architect's tool path omits
  // it — its seats materialize at finalize.
  materializeFor?: db.Participant;
}): Promise<db.WorkflowRow> {
  const count = await db.countWorkspaceWorkflows(args.workspaceId);
  if (count >= MAX_WORKFLOWS_PER_WORKSPACE) {
    throw new ApiError(400, `this workspace already has ${count} workflows (max ${MAX_WORKFLOWS_PER_WORKSPACE})`);
  }
  const template = args.templateId ? getWorkflowTemplate(args.templateId) : undefined;
  if (args.templateId && !template) throw new ApiError(400, `unknown template ${JSON.stringify(args.templateId)}`);
  let row = await db.createWorkflow({
    workspaceId: args.workspaceId,
    name: args.name?.trim() || template?.name || "New workflow",
    description: template?.description ?? "",
    emoji: template?.emoji ?? null,
    status: "draft",
    templateId: template?.id ?? null,
    trigger: template?.trigger ?? { type: "manual" },
    roster: template?.roster ?? [],
    playbook: template?.playbook ?? "",
    createdBy: args.createdBy,
  });
  if (args.materializeFor) row = await materializeSeats(row, args.materializeFor);
  broadcastWorkspace(args.workspaceId, { type: "workflow_changed", workflowId: row.id, action: "created" });
  return row;
}

// --- Seats are real agents from draft time (unprovisioned = no machine, no cost) ---
//
// A workflow is deliberately just existing Jungle pieces composed: seats are ordinary agents
// (persona = the seat's instructions, integrations via the ordinary integrations editor), the
// cron trigger is an ordinary schedule row, runs live in an ordinary channel. The only net-new
// concept is the playbook. Creating a draft therefore creates its agents immediately — the
// builder can open the REAL profile panel on them — but provisioning (the machine) waits for
// finalize, and deleting a draft deletes its never-provisioned agents again.

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workflow"
  );
}

// Best-effort integration attach (same resolution as POST /api/agents, but non-fatal): a key
// whose underlying connection isn't linked yet just stays unattached — the builder shows it as
// "needs setup" and the profile panel's ordinary flow fixes it. `repo` supplies the github
// config; other per-integration config is set later via the profile panel.
// Returns how many integrations were newly attached, so callers can reconfigure a live runner
// only when something actually changed.
export async function tryAttachIntegrations(
  actor: db.Participant,
  agentId: string,
  keys: string[],
  settings?: Record<string, Record<string, unknown>>,
): Promise<number> {
  const { adapterFor } = await import("../integrations");
  const { getIntegrationType } = await import("@jungle/shared");
  let attached = 0;
  for (const key of keys) {
    const type = getIntegrationType(key);
    if (!type || type.comingSoon) continue;
    try {
      const existing = await db.getAgentIntegration(agentId, key);
      if (existing) continue;
      // The seat's settings spec for this integration (repo, requireApproval, …); callers fold the
      // legacy top-level repo in via rosterIntegrationSettings before passing this map.
      const raw: Record<string, unknown> = settings?.[key] ?? {};
      const adapter = adapterFor(key);
      const config = adapter?.resolveConfig
        ? await adapter.resolveConfig({ me: actor, agentId, existing: null }, raw)
        : raw;
      await db.setAgentIntegration(agentId, key, config);
      attached++;
    } catch (e) {
      console.log(`workflow seat ${agentId}: integration ${key} not attached yet: ${(e as Error).message}`);
    }
  }
  return attached;
}

// Attach-or-UPDATE per-integration config for a seat agent. Unlike tryAttachIntegrations (which
// skips keys already attached), this re-resolves and writes config for the given keys, so a
// changed repo / flipped approval on a LIVE integration actually takes effect. Each desired config
// is merged over the integration's existing settable config first, so a partial edit (just the
// repo) never drops a sibling field (the commit author). Best-effort per key: an unconnected
// integration throws in resolveConfig and is left pending (the roster spec still records the wish).
// Returns how many integrations' stored config actually changed, so callers reconfigure only then.
export async function applyIntegrationSettings(
  actor: db.Participant,
  agentId: string,
  keys: string[],
  settings: Record<string, Record<string, unknown>>,
): Promise<number> {
  const { adapterFor } = await import("../integrations");
  const { getIntegrationType, filterToSettableKeys } = await import("@jungle/shared");
  let changed = 0;
  for (const key of keys) {
    const type = getIntegrationType(key);
    if (!type || type.comingSoon) continue;
    try {
      const existing = await db.getAgentIntegration(agentId, key);
      const raw: Record<string, unknown> = {
        ...(existing ? filterToSettableKeys(key, existing.config) : {}),
        ...(settings[key] ?? {}),
      };
      const adapter = adapterFor(key);
      const config = adapter?.resolveConfig
        ? await adapter.resolveConfig({ me: actor, agentId, existing: existing?.config ?? null }, raw)
        : raw;
      if (existing && JSON.stringify(existing.config) === JSON.stringify(config)) continue;
      await db.setAgentIntegration(agentId, key, config);
      changed++;
    } catch (e) {
      console.log(`workflow seat ${agentId}: settings for ${key} not applied yet: ${(e as Error).message}`);
    }
  }
  return changed;
}

// Build the settings map (integration key → config spec) for one roster seat, folding the legacy
// top-level `repo` field into settings.github.repo. The shape tryAttachIntegrations expects.
export function seatSettingsMap(role: {
  integrations: string[];
  repo?: string;
  settings?: Record<string, Record<string, unknown>>;
}): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const key of role.integrations) out[key] = rosterIntegrationSettings(role as WorkflowRole, key);
  return out;
}

// Create one seat's agent: an ordinary participant row with an animal-preset identity and the
// seat's instructions as persona. NOT provisioned — that happens at finalize.
async function createSeatAgent(
  workspaceId: string,
  actor: db.Participant,
  seat: {
    name: string;
    handle: string;
    persona: string;
    integrations: string[];
    repo?: string;
    settings?: Record<string, Record<string, unknown>>;
  },
): Promise<db.Participant> {
  let handle = seat.handle;
  for (let i = 2; !(await db.handleAvailable(workspaceId, handle)); i++) {
    handle = `${seat.handle}-${i}`;
    if (i > 50) throw new ApiError(500, "couldn't find a free handle");
  }
  const runnerToken = randomBytes(32).toString("hex");
  const participant = await db.withTransaction(async (client) => {
    const { count, cap } = await db.agentCountAndCap(client, workspaceId);
    if (count >= cap) throw new ApiError(409, `this workspace has reached its agent limit (${cap})`);
    return db.createParticipant(
      {
        kind: "agent",
        workspaceId,
        handle,
        displayName: seat.name,
        runtime: "sdk",
        runnerToken,
        model: null,
        mode: "default",
        runnerProvider: "fly",
        persona: seat.persona || null,
      },
      client,
    );
  });
  await tryAttachIntegrations(actor, participant.id, seat.integrations, seatSettingsMap(seat));
  return participant;
}

// Assign an unused animal preset for a new seat (workspace-wide + within-draft uniqueness).
async function pickSeatPreset(workspaceId: string, usedInDraft: Set<string>) {
  const { AGENT_PRESETS } = await import("@jungle/shared");
  const candidates = AGENT_PRESETS.filter((p) => !usedInDraft.has(p.handle));
  for (const p of candidates.sort(() => Math.random() - 0.5)) {
    if (await db.handleAvailable(workspaceId, p.handle)) {
      usedInDraft.add(p.handle);
      return p;
    }
  }
  // Every animal taken: fall back to a suffixed random one (createSeatAgent dedups further).
  const p = AGENT_PRESETS[Math.floor(Math.random() * AGENT_PRESETS.length)];
  usedInDraft.add(p.handle);
  return p;
}

// Materialize a draft's seats as real (unprovisioned) agents: called right after createDraft
// for template drafts, and by addSeat for one-off additions.
export async function materializeSeats(wf: db.WorkflowRow, actor: db.Participant): Promise<db.WorkflowRow> {
  const used = new Set<string>(
    wf.roster.map((r) => r.handle_seed).filter((h) => !!h),
  );
  const roster: WorkflowRole[] = [];
  let changed = false;
  for (const role of wf.roster) {
    if (role.participant_id) {
      roster.push(role);
      continue;
    }
    const preset = await pickSeatPreset(wf.workspace_id, used);
    const agent = await createSeatAgent(wf.workspace_id, actor, {
      name: preset.name,
      handle: preset.handle,
      persona: role.duties,
      integrations: role.integrations,
      repo: role.repo,
      settings: role.settings,
    });
    roster.push({
      ...role,
      name: agent.display_name,
      handle_seed: agent.handle,
      participant_id: agent.id,
    });
    changed = true;
  }
  if (!changed) return wf;
  const updated = (await db.updateWorkflow(wf.id, { roster })) ?? wf;
  broadcastWorkspace(wf.workspace_id, { type: "workflow_changed", workflowId: wf.id, action: "updated" });
  return updated;
}

// Add one blank seat to a draft (builder's "+ Add agent").
export async function addSeat(
  wf: db.WorkflowRow,
  actor: db.Participant,
  roleTitle?: string,
): Promise<db.WorkflowRow> {
  if (wf.status !== "draft") throw new ApiError(400, "seats can only be added to drafts");
  const { WORKFLOW_MAX_ROLES } = await import("@jungle/shared");
  if (wf.roster.length >= WORKFLOW_MAX_ROLES) throw new ApiError(400, `at most ${WORKFLOW_MAX_ROLES} seats`);
  const used = new Set<string>(wf.roster.map((r) => r.handle_seed));
  const preset = await pickSeatPreset(wf.workspace_id, used);
  const agent = await createSeatAgent(wf.workspace_id, actor, {
    name: preset.name,
    handle: preset.handle,
    persona: "",
    integrations: [],
  });
  const roster = [
    ...wf.roster,
    {
      role: roleTitle?.trim() || "Teammate",
      name: agent.display_name,
      handle_seed: agent.handle,
      duties: "",
      integrations: [],
      participant_id: agent.id,
    },
  ];
  const updated = (await db.updateWorkflow(wf.id, { roster })) ?? wf;
  broadcastWorkspace(wf.workspace_id, { type: "workflow_changed", workflowId: wf.id, action: "updated" });
  return updated;
}

// Remove a seat from a draft; its agent is deleted too when it was never provisioned (the
// draft created it, the draft can take it back).
export async function removeSeat(
  wf: db.WorkflowRow,
  participantId: string,
): Promise<db.WorkflowRow> {
  if (wf.status !== "draft") throw new ApiError(400, "seats can only be removed from drafts");
  const roster = wf.roster.filter((r) => r.participant_id !== participantId);
  if (roster.length === wf.roster.length) throw new ApiError(404, "no such seat");
  const agent = await db.getParticipant(participantId).catch(() => null);
  if (agent && agent.kind === "agent" && !agent.runner_meta) {
    await db.deleteAgent(participantId);
    broadcastWorkspace(wf.workspace_id, { type: "participant_deleted", participantId });
  }
  const updated = (await db.updateWorkflow(wf.id, { roster })) ?? wf;
  broadcastWorkspace(wf.workspace_id, { type: "workflow_changed", workflowId: wf.id, action: "updated" });
  return updated;
}

// Deleting a DRAFT takes its never-provisioned agents with it (they only ever existed for the
// draft). Live workflows keep their agents on delete — those have history.
export async function cleanupDraftAgents(wf: db.WorkflowRow): Promise<void> {
  if (wf.status !== "draft") return;
  for (const role of wf.roster) {
    if (!role.participant_id) continue;
    const agent = await db.getParticipant(role.participant_id).catch(() => null);
    if (agent && agent.kind === "agent" && !agent.runner_meta) {
      await db.deleteAgent(agent.id);
      broadcastWorkspace(wf.workspace_id, { type: "participant_deleted", participantId: agent.id });
    }
  }
}

// Keep rosters in lockstep with an agent's attached integrations: attaching a key adds it to
// every roster seat the agent occupies (draft or live), detaching scrubs it. The canvas chips
// and the Connections panel both read the roster, so this is what makes them follow edits made
// in the agent's profile panel. Roster integrations drive presentation + finalize's attach pass
// only — runtime grants come from agent_integrations — so syncing never changes what a run can do.
export async function syncRosterIntegration(
  agentId: string,
  key: string,
  op: "attach" | "detach",
  config?: Record<string, unknown>,
): Promise<void> {
  const { filterToSettableKeys } = await import("@jungle/shared");
  // The settable settings for this integration (repo, requireApproval, …) so the roster spec
  // mirrors what the profile panel just saved. The repo shorthand also stays in sync for github.
  const settable = op === "attach" && config ? filterToSettableKeys(key, config) : {};
  const repo = key === "github" && typeof settable.repo === "string" && settable.repo ? settable.repo : undefined;
  for (const wf of await db.workflowsForParticipant(agentId)) {
    let changed = false;
    const roster = wf.roster.map((r) => {
      if (r.participant_id !== agentId) return r;
      if (op === "attach") {
        const has = r.integrations.includes(key);
        const settingsChanged = JSON.stringify(r.settings?.[key] ?? {}) !== JSON.stringify(settable);
        if (has && !settingsChanged) return r;
        changed = true;
        const n: WorkflowRole = { ...r, integrations: has ? r.integrations : [...r.integrations, key] };
        n.settings = { ...(r.settings ?? {}), [key]: settable };
        if (repo) n.repo = repo;
        return n;
      }
      if (!r.integrations.includes(key)) return r;
      changed = true;
      const n: WorkflowRole = { ...r, integrations: r.integrations.filter((k) => k !== key) };
      if (r.settings?.[key]) {
        n.settings = { ...r.settings };
        delete n.settings[key];
      }
      if (key === "github") delete n.repo;
      return n;
    });
    if (!changed) continue;
    await db.updateWorkflow(wf.id, { roster });
    broadcastWorkspace(wf.workspace_id, { type: "workflow_changed", workflowId: wf.id, action: "updated" });
  }
}

// The compile step: provision every seat's agent (create machines), create (or adopt) the home
// channel, add members, create the backing schedule row for cron triggers, set active.
// Idempotent-ish: rerun after a failure just fills in what's missing. Roles without agents yet
// (Architect-made drafts) get them created here.
export async function finalizeWorkflow(
  wf: db.WorkflowRow,
  actor: db.Participant,
  opts?: { homeChannelId?: string },
): Promise<db.WorkflowRow> {
  if (wf.status !== "draft") throw new ApiError(400, "workflow is already live");
  if (!wf.roster.length) throw new ApiError(400, "add at least one agent to the team first");

  // 1. Agents: materialize any missing seats, then provision machines for all of them.
  const materialized = await materializeSeats(wf, actor);
  const roster = materialized.roster;
  for (const role of roster) {
    const agent = await db.getAgentRow(role.participant_id!);
    if (!agent) continue;
    // One more integration-attach pass: connections linked since the draft was made now stick.
    await tryAttachIntegrations(actor, agent.id, role.integrations, seatSettingsMap(role));
    if (!agent.runner_meta && agent.runner_token) {
      const runnerToken = agent.runner_token;
      void (async () => {
        try {
          await provisionerFor(agent).create({ id: agent.id, handle: agent.handle, runnerToken });
          await provisionerFor(agent).start(agent.id);
          runners.noteProvisionerStart(agent.id);
        } catch (e) {
          console.error(`workflow ${wf.id}: provision @${agent.handle}:`, e);
        }
      })();
    }
  }

  // 2. Home channel: adopt the chosen one or create #<slug> (suffixing until free).
  let homeChannelId = opts?.homeChannelId ?? wf.home_channel_id;
  if (homeChannelId) {
    const ch = await db.getChannel(homeChannelId);
    if (!ch || ch.workspace_id !== wf.workspace_id || ch.kind !== "channel") {
      throw new ApiError(400, "home channel not found in this workspace");
    }
  } else {
    const base = slugify(wf.name);
    let name = base;
    for (let i = 2; ; i++) {
      try {
        const ch = await db.createChannel({
          workspaceId: wf.workspace_id,
          name,
          kind: "channel",
          memberHandles: [],
        });
        homeChannelId = ch.id;
        break;
      } catch {
        name = `${base}-${i}`;
        if (i > 20) throw new ApiError(500, "couldn't create a home channel");
      }
    }
  }
  // 3. Membership: every member agent + the creator (so the run threads are visible/steerable).
  for (const r of roster) await db.addChannelMember(homeChannelId!, r.participant_id!);
  await db.addChannelMember(homeChannelId!, actor.id);
  broadcastWorkspace(wf.workspace_id, { type: "members_changed", channelId: homeChannelId! });

  // 4. Backing schedule for scheduled/one-time triggers (ticker branches on workflow_id — see
  // scheduler.ts). A 'once' trigger backs a one-shot row (run_at set, cron/timezone null): the
  // ticker fires it a single time, then next_run_at goes null and the run-close hook completes it.
  const trigger = wf.trigger;
  if (trigger.type === "schedule" || trigger.type === "once") {
    const existing = await db.getWorkflowBackingSchedule(wf.id);
    if (!existing) {
      await db.createSchedule({
        workspaceId: wf.workspace_id,
        agentId: roster[0].participant_id!,
        channelId: homeChannelId!,
        createdBy: actor.id,
        prompt: `[workflow trigger] ${wf.name}`, // never dispatched as a prompt; ticker branches
        cron: trigger.type === "schedule" ? trigger.cron : null,
        timezone: trigger.type === "schedule" ? trigger.timezone : null,
        runAt: trigger.type === "once" ? trigger.runAt : null,
        nextRunAt: trigger.type === "schedule" ? computeNextRun(trigger.cron, trigger.timezone) : trigger.runAt,
        workflowId: wf.id,
      });
    }
  }

  const updated =
    (await db.updateWorkflow(wf.id, { status: "active", homeChannelId, roster })) ?? wf;
  // Members' prompts now include the workflow section — refresh any live runners.
  for (const r of roster) void runners.reconfigure(r.participant_id!).catch(() => {});
  broadcastWorkspace(wf.workspace_id, { type: "workflow_changed", workflowId: wf.id, action: "updated" });
  return updated;
}

// --- Runs ---

const RUN_COMPLETE_RE = /^(?:✅\s*)?run\s+complete\b[:,.!—-]?\s*/i;

function triggerNoun(t: db.WorkflowRunRow["trigger"]): string {
  return t === "schedule" ? "on schedule" : t === "manual" ? "started by hand" : "from a message";
}

// Kickoff prompt for the intake agent. Self-contained, like a scheduled turn: the agent may
// have no memory of this workflow beyond its prompt section, so restate the essentials.
function buildKickoffInput(
  wf: db.WorkflowRow,
  run: db.WorkflowRunRow,
  intakeHandle: string,
  channelName: string,
  rosterLine: string,
  triggerText?: string,
): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    `[Jungle turn] WORKFLOW RUN kickoff for @${intakeHandle} · now: ${now}\n` +
    `Your workflow “${wf.name}” is starting a run (${triggerNoun(run.trigger)}). ` +
    `You are the intake role — you go first.\n\n` +
    `Playbook:\n>>> ${wf.playbook || "(none — use your judgment)"}\n\n` +
    `Team: ${rosterLine}\n` +
    (triggerText ? `\nTriggering message:\n>>> ${triggerText}\n` : "") +
    `\nWork happens in the run thread: reply in the thread under the run-started message in ` +
    `#${channelName} (send_message to:"#${channelName}" — your replies default into that thread). ` +
    `Hand work to teammates by @mentioning them there. When the playbook says the run is ` +
    `finished, whoever reports posts a thread message that STARTS with "Run complete:" followed ` +
    `by a 1–3 sentence summary — that closes the run. If there's nothing to do this run, post ` +
    `"Run complete: nothing to do" and stop.`
  );
}

// Start a run: guard, run-header message (the thread anchor), kickoff dispatch to intake.
export async function startRun(
  wf: db.WorkflowRow,
  trigger: db.WorkflowRunRow["trigger"],
  opts?: { triggerText?: string; rootMessageId?: string },
): Promise<db.WorkflowRunRow> {
  if (wf.status !== "active") throw new ApiError(400, `workflow is ${wf.status} — activate it first`);
  const live = await db.getLiveWorkflowRun(wf.id);
  if (live) throw new ApiError(409, "a run is already in progress — stop it first or let it finish");
  const intake = wf.roster[0];
  if (!intake?.participant_id) throw new ApiError(400, "workflow has no intake agent");
  const agent = await db.getAgentRow(intake.participant_id);
  const channel = wf.home_channel_id ? await db.getChannel(wf.home_channel_id) : null;
  if (!agent || !channel) throw new ApiError(400, "workflow's intake agent or home channel is missing");

  // Self-healing integration attach: connections made AFTER finalize (e.g. the user connected
  // Google from the Liana web app once the workflow already existed) stick at the next run.
  // No-ops when everything is already attached; reconfigures live runners only on change.
  if (wf.created_by) {
    const creator = await db.getParticipant(wf.created_by);
    if (creator) {
      for (const r of wf.roster) {
        if (!r.participant_id) continue;
        const attached = await tryAttachIntegrations(creator, r.participant_id, r.integrations, seatSettingsMap(r));
        if (attached > 0) void runners.reconfigure(r.participant_id).catch(() => {});
      }
    }
  }

  const run = await db.createWorkflowRun({
    workflowId: wf.id,
    workspaceId: wf.workspace_id,
    trigger,
    rootMessageId: opts?.rootMessageId ?? null,
  });

  // The run-header message anchors the run's thread (unless a triggering message already does).
  let rootId = opts?.rootMessageId ?? null;
  if (!rootId) {
    const header = await db.persistMessage({
      channelId: channel.id,
      senderId: agent.id,
      body: `▶️ ${wf.emoji ? wf.emoji + " " : ""}**${wf.name}** — run started (${triggerNoun(trigger)}). Follow along in this thread.`,
      cascadeBudget: 0, // the kickoff dispatch below is explicit; the header must not double-trigger
    });
    rootId = header.id;
    await db.setWorkflowRunRoot(run.id, rootId);
    run.root_message_id = rootId;
    await fanOut(channel.id, { type: "message", message: att.withUrls(header) });
  }

  // Roster line for the kickoff prompt (roster stores participant ids; resolve handles).
  const handles: string[] = [];
  for (const r of wf.roster) {
    const p = r.participant_id ? await db.getParticipant(r.participant_id) : null;
    handles.push(p ? `@${p.handle} (${r.role})` : `(${r.role} — missing)`);
  }

  await db.enqueueInboxItem(
    agent.id,
    buildKickoffInput(wf, run, agent.handle, channel.name, handles.join(", "), opts?.triggerText),
    undefined,
    {
      budget: DEFAULT_CASCADE_BUDGET,
      channelId: channel.id,
      threadRootId: rootId,
      workflowRunId: run.id,
    },
  );
  await runners.drain(agent.id);
  if (!runners.isConnected(agent.id)) {
    try {
      await provisionerFor(agent).start(agent.id);
      runners.noteProvisionerStart(agent.id);
    } catch (e) {
      console.error(`workflow ${wf.id}: wake intake failed:`, e);
    }
  }
  broadcastWorkspace(wf.workspace_id, { type: "workflow_run_changed", workflowId: wf.id, runId: run.id });
  return run;
}

// Ticker branch: a claimed schedule row with workflow_id fires a run instead of an agent turn.
export async function startRunFromSchedule(s: db.ScheduleRow): Promise<void> {
  if (!s.workflow_id) return;
  const wf = await db.getWorkflow(s.workflow_id);
  if (!wf || wf.status !== "active") return;
  try {
    await startRun(wf, "schedule");
  } catch (e) {
    // Overlap (previous run still live) is expected sometimes; skip quietly but visibly.
    console.error(`workflow ${wf.id}: scheduled run skipped:`, (e as Error).message);
  }
}

export async function stopRun(run: db.WorkflowRunRow, by: string): Promise<db.WorkflowRunRow> {
  const updated = (await db.setWorkflowRunStatus(run.id, "stopped", `Stopped by ${by}.`)) ?? run;
  broadcastWorkspace(run.workspace_id, { type: "workflow_run_changed", workflowId: run.workflow_id, runId: run.id });
  return updated;
}

// Completion detection: an agent message in a live run's thread starting with "Run complete:"
// closes the run (the message itself is the human-visible summary — deliberately not a hidden
// tool so it works on every runner image and reads naturally in the thread).
export async function completeRunFromMessage(msg: {
  thread_root_id: string | null;
  sender_id: string;
  body: string;
}): Promise<void> {
  if (!msg.thread_root_id || !RUN_COMPLETE_RE.test(msg.body)) return;
  const run = await db.getLiveRunByRootMessage(msg.thread_root_id);
  if (!run) return;
  const wf = await db.getWorkflow(run.workflow_id);
  if (!wf) return;
  if (!wf.roster.some((r) => r.participant_id === msg.sender_id)) return; // members only
  const summary = msg.body.replace(RUN_COMPLETE_RE, "").trim() || null;
  await db.setWorkflowRunStatus(run.id, "done", summary);
  broadcastWorkspace(run.workspace_id, { type: "workflow_run_changed", workflowId: run.workflow_id, runId: run.id });
  // Liana-owned workflows deliver the run's output to the owner's Slack DM. Dynamic import —
  // liana.ts statically imports this module, so a static import here would cycle.
  void import("./liana").then((l) => l.onRunClosed(run.id)).catch((e) => console.error("liana delivery:", e));
  await completeOnceWorkflow(wf);
}

// A one-time ('once') workflow fires exactly one run; when that run closes it is done, so move it
// to the terminal 'completed' status (its backing schedule already won't refire — the ticker
// nulled next_run_at after the single fire). No-op for recurring/manual/draft workflows.
async function completeOnceWorkflow(wf: db.WorkflowRow): Promise<void> {
  if (wf.trigger.type !== "once" || wf.status === "completed" || wf.status === "draft") return;
  await db.updateWorkflow(wf.id, { status: "completed" });
  // Disarm the backing schedule so it can never refire — covers a manual Run-now that closed the
  // run before the scheduled time (the ticker nulls next_run_at itself when it does the firing).
  await db.pool.query(`update schedules set next_run_at = null where workflow_id = $1`, [wf.id]);
  broadcastWorkspace(wf.workspace_id, { type: "workflow_changed", workflowId: wf.id, action: "updated" });
}

// The workflow section of a member agent's system prompt: its role, the playbook, the team, and
// how runs end. Assembled in runners.buildConfigure alongside integration blocks.
export async function workflowPromptBlocks(agentId: string): Promise<string[]> {
  const rows = await db.workflowsForParticipant(agentId);
  const blocks: string[] = [];
  for (const wf of rows) {
    if (wf.status === "draft") continue;
    const mine = wf.roster.find((r) => r.participant_id === agentId);
    const handles: string[] = [];
    for (const r of wf.roster) {
      const p = r.participant_id ? await db.getParticipant(r.participant_id) : null;
      if (p) handles.push(`@${p.handle} — ${r.role}${p.id === agentId ? " (you)" : ""}`);
    }
    const channel = wf.home_channel_id ? await db.getChannel(wf.home_channel_id) : null;
    blocks.push(
      `You are part of the workflow “${wf.name}”${wf.status === "paused" ? " (currently paused)" : ""}. ` +
      `Your role: ${mine?.role ?? "member"}. Team: ${handles.join("; ")}. ` +
      `Home channel: #${channel?.name ?? "?"} — each run is one thread there; keep run work in ` +
      `that thread and hand off by @mentioning teammates in it.\n` +
      `Playbook: ${wf.playbook || "(none)"}\n` +
      `Ending a run: when the playbook says the run is finished, the reporting role posts a ` +
      `thread message that starts with "Run complete:" plus a 1–3 sentence summary. Only say ` +
      `that when the run is actually done — it closes the run.`,
    );
  }
  return blocks;
}

// --- Architect: the builder agent + the workflow_* tool hooks (runner protocol) ---

const ARCHITECT_HANDLE = "architect";

const ARCHITECT_PERSONA =
  `You are the workspace's workflow Architect. Your job: turn what someone describes in plain ` +
  `words into a small, dead-simple team of agents — a WORKFLOW — using your workflow_* tools. ` +
  `Principles: fewest agents that can do the job (1 is great, 2–4 typical); a short prose ` +
  `playbook (who does what, who reports, how a run ends); prefer templates as starting points ` +
  `(workflow_list_templates). Flow: create or reuse a draft (workflow_draft_create), shape it ` +
  `with workflow_draft_set after each answer the user gives you — they can literally watch the ` +
  `draft update on the Workflows page — and only call workflow_finalize when the user clearly ` +
  `says go. Finalize creates real agents and a home channel, so never do it unasked. You can ` +
  `Each seat becomes a fresh agent (a Jungle animal name is assigned automatically). Ask at most ` +
  `one or two crisp questions at a time; propose defaults instead of interrogating. After finalizing, tell ` +
  `them how it starts (trigger), where runs happen (the home channel), and that they can hit ` +
  `Run now to try it immediately.`;

// Find-or-create the workspace's Architect agent (a normal runner-backed agent; lazily
// provisioned the first time someone opens the builder).
export async function ensureArchitect(workspaceId: string): Promise<db.Participant> {
  const existing = await db.getParticipantByHandle(workspaceId, ARCHITECT_HANDLE);
  if (existing) return existing;
  const runnerToken = randomBytes(32).toString("hex");
  const participant = await db.withTransaction(async (client) => {
    const { count, cap } = await db.agentCountAndCap(client, workspaceId);
    if (count >= cap) throw new ApiError(409, `this workspace has reached its agent limit (${cap})`);
    return db.createParticipant(
      {
        kind: "agent",
        workspaceId,
        handle: ARCHITECT_HANDLE,
        displayName: "Architect",
        runtime: "sdk",
        runnerToken,
        model: null,
        mode: "default",
        runnerProvider: "fly",
        persona: ARCHITECT_PERSONA,
      },
      client,
    );
  });
  void (async () => {
    try {
      await provisionerFor(participant).create({ id: participant.id, handle: ARCHITECT_HANDLE, runnerToken });
      await provisionerFor(participant).start(participant.id);
      runners.noteProvisionerStart(participant.id);
    } catch (e) {
      console.error("provision architect:", e);
    }
  })();
  return participant;
}

// Kick the Architect when someone opens the builder: a self-contained turn telling it which
// draft to shape and to greet the user in their DM. Same dispatch tail as every other turn.
export async function kickoffArchitect(
  architect: db.Participant,
  user: db.Participant,
  draft: db.WorkflowRow,
  dmChannelId: string,
): Promise<void> {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const input =
    `[Jungle turn] BUILDER opened by @${user.handle} · now: ${now}\n` +
    `They want to build a workflow. Work with draft ${draft.id}` +
    (draft.template_id
      ? ` (pre-filled from the "${draft.template_id}" template — confirm the plan and tailor it rather than starting from scratch).`
      : ` (blank).`) +
    ` Greet them in this DM: one short message — what the draft is set up to do (workflow_draft_get ` +
    `to see it) and the one or two questions that matter most (repo? which inbox? bind existing ` +
    `agents?). Shape the draft with workflow_draft_set as they answer — they can watch it update ` +
    `on the Workflows page — and call workflow_finalize only when they say go.`;
  const agent = await db.getAgentRow(architect.id);
  if (!agent) return;
  await db.enqueueInboxItem(agent.id, input, undefined, {
    budget: DEFAULT_CASCADE_BUDGET,
    channelId: dmChannelId,
    threadRootId: null,
  });
  await runners.drain(agent.id);
  if (!runners.isConnected(agent.id)) {
    try {
      await provisionerFor(agent).start(agent.id);
      runners.noteProvisionerStart(agent.id);
    } catch (e) {
      console.error("wake architect:", e);
    }
  }
}

// Rendered draft for tool results — what the agent reads back after each edit.
function renderDraft(wf: db.WorkflowRow, handlesById: Map<string, string>): string {
  const trig = wf.trigger;
  const trigText =
    trig.type === "schedule"
      ? `schedule (cron ${trig.cron} in ${trig.timezone})`
      : trig.type === "channel_message"
        ? "channel message (@mention the first seat in the home channel)"
        : "manual (Run now)";
  const roster = wf.roster
    .map((r, i) => {
      const bound = r.participant_id ? ` -> @${handlesById.get(r.participant_id) ?? "?"}` : ` (new @${r.handle_seed})`;
      return `  ${i + 1}. ${r.role}${i === 0 ? " [intake — goes first]" : ""}${bound}: ${r.duties || "(no duties yet)"}${r.integrations.length ? ` [wants: ${r.integrations.join(", ")}]` : ""}`;
    })
    .join("\n");
  return (
    `Draft ${wf.id} — “${wf.name}” (${wf.status})\n` +
    `Trigger: ${trigText}\n` +
    `Team:\n${roster || "  (empty)"}\n` +
    `Playbook: ${wf.playbook || "(empty)"}`
  );
}

async function draftHandles(wf: db.WorkflowRow): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const r of wf.roster) {
    if (!r.participant_id) continue;
    const p = await db.getParticipant(r.participant_id);
    if (p) m.set(p.id, p.handle);
  }
  return m;
}

type WorkflowToolResult = { ok: boolean; error?: string; text?: string; draftId?: string; workflowId?: string };

export async function toolListTemplates(): Promise<WorkflowToolResult> {
  const { WORKFLOW_TEMPLATES } = await import("@jungle/shared");
  const text = WORKFLOW_TEMPLATES.map(
    (t) =>
      `${t.id}: ${t.name} — ${t.description} (${t.roster.length} agent${t.roster.length === 1 ? "" : "s"}; trigger: ${t.trigger.type})`,
  ).join("\n");
  return { ok: true, text };
}

export async function toolDraftCreate(
  agent: db.AgentRow,
  input: { templateId?: string; name?: string },
): Promise<WorkflowToolResult> {
  try {
    const row = await createDraft({
      workspaceId: agent.workspace_id,
      createdBy: agent.id,
      templateId: input.templateId,
      name: input.name,
    });
    return { ok: true, draftId: row.id, text: renderDraft(row, await draftHandles(row)) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function requireDraftInWorkspace(agent: db.AgentRow, draftId: string): Promise<db.WorkflowRow> {
  const wf = await db.getWorkflow(String(draftId ?? ""));
  if (!wf || wf.workspace_id !== agent.workspace_id) throw new ApiError(404, "no such workflow in this workspace");
  return wf;
}

export async function toolDraftGet(agent: db.AgentRow, input: { draftId: string }): Promise<WorkflowToolResult> {
  try {
    const wf = await requireDraftInWorkspace(agent, input.draftId);
    return { ok: true, draftId: wf.id, text: renderDraft(wf, await draftHandles(wf)) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function toolDraftSet(
  agent: db.AgentRow,
  input: { draftId: string } & import("@jungle/shared").WorkflowDraftInput,
): Promise<WorkflowToolResult> {
  try {
    const wf = await requireDraftInWorkspace(agent, input.draftId);
    if (wf.status !== "draft") return { ok: false, error: "that workflow is already live — only drafts can be reshaped (playbook edits: the human can do those from the workflow page)" };
    const patch: Parameters<typeof db.updateWorkflow>[1] = {};
    if (input.name !== undefined) patch.name = validateName(input.name);
    if (input.description !== undefined) patch.description = String(input.description).slice(0, 500);
    if (input.emoji !== undefined) patch.emoji = input.emoji ? String(input.emoji).slice(0, 8) : null;
    if (input.playbook !== undefined) patch.playbook = validatePlaybook(input.playbook);
    if (input.trigger !== undefined) patch.trigger = validateTrigger(input.trigger);
    if (input.roster !== undefined) {
      // Seats are always fresh agents (created at finalize for the Architect path); a seat keeps
      // its existing participant_id if the agent named a role that already has one.
      const existingByRole = new Map(wf.roster.map((r) => [r.role, r.participant_id]));
      patch.roster = validateRoster(
        input.roster.map((raw) => ({
          role: String(raw.role ?? ""),
          handle_seed: String(raw.handle_seed ?? ""),
          duties: String(raw.duties ?? ""),
          integrations: raw.integrations ?? [],
          ...(raw.repo ? { repo: String(raw.repo) } : {}),
          ...(existingByRole.get(String(raw.role ?? "")) ? { participant_id: existingByRole.get(String(raw.role ?? "")) } : {}),
        })),
      );
    }
    const updated = (await db.updateWorkflow(wf.id, patch)) ?? wf;
    broadcastWorkspace(wf.workspace_id, { type: "workflow_changed", workflowId: wf.id, action: "updated" });
    return { ok: true, draftId: wf.id, text: renderDraft(updated, await draftHandles(updated)) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function toolFinalize(
  agent: db.AgentRow,
  input: { draftId: string; homeChannel?: string },
): Promise<WorkflowToolResult> {
  try {
    const wf = await requireDraftInWorkspace(agent, input.draftId);
    let homeChannelId: string | undefined;
    if (input.homeChannel) {
      const ch = await db.getChannelByNameForMember(input.homeChannel.replace(/^#/, ""), agent.id);
      if (!ch) return { ok: false, error: `you are not a member of channel ${input.homeChannel} (or it doesn't exist)` };
      homeChannelId = ch.id;
    }
    // Actor for channel membership: the human who owns the draft when there is one (builder
    // flow sets created_by to the human), else the workflow's creator agent.
    const creator = wf.created_by ? await db.getParticipant(wf.created_by) : null;
    const finalized = await finalizeWorkflow(wf, creator ?? (agent as unknown as db.Participant), { homeChannelId });
    return {
      ok: true,
      workflowId: finalized.id,
      text: renderDraft(finalized, await draftHandles(finalized)),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// --- Stall / quiescence sweep ---
//
// One rule each, run by a 60s ticker over live runs:
//   stall:   running + no activity for WORKFLOW_STALL_MINUTES + nobody mid-turn + no pending
//            approval  -> stalled, with one visible nudge in the run thread.
//   revive:  stalled + fresh activity -> running.
//   quiesce: live + no activity for WORKFLOW_QUIESCENCE_DONE_MINUTES + all members idle ->
//            done ("team went quiet") — the fallback for a team that forgot "Run complete:".

const SWEEP_MS = Number(process.env.WORKFLOW_SWEEP_MS ?? 60_000);
let sweeping = false;

export function startWorkflowSweeper(): void {
  setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void sweep()
      .catch((e) => console.error("workflow sweep:", e))
      .finally(() => {
        sweeping = false;
      });
  }, SWEEP_MS).unref();
}

async function sweep(): Promise<void> {
  const { WORKFLOW_STALL_MINUTES, WORKFLOW_QUIESCENCE_DONE_MINUTES } = await import("@jungle/shared");
  const { hasPendingConfirmForAgents } = await import("./confirmations");
  for (const run of await db.listLiveWorkflowRuns()) {
    const wf = await db.getWorkflow(run.workflow_id);
    if (!wf) continue;
    const memberIds = wf.roster.map((r) => r.participant_id).filter((x): x is string => !!x);
    const last = new Date(await db.workflowRunLastActivity(run)).getTime();
    const idleMinutes = (Date.now() - last) / 60_000;
    const anyWorking = memberIds.some((id) => runners.agentStatus(id) === "working");
    const awaitingApproval = hasPendingConfirmForAgents(memberIds);

    if (run.status === "stalled" && (idleMinutes < WORKFLOW_STALL_MINUTES || anyWorking)) {
      await db.setWorkflowRunStatus(run.id, "running");
      broadcastWorkspace(run.workspace_id, { type: "workflow_run_changed", workflowId: wf.id, runId: run.id });
      continue;
    }
    if (anyWorking || awaitingApproval) continue;

    if (idleMinutes >= WORKFLOW_QUIESCENCE_DONE_MINUTES) {
      await db.setWorkflowRunStatus(run.id, "done", "Auto-completed: the team went quiet without posting a summary.");
      broadcastWorkspace(run.workspace_id, { type: "workflow_run_changed", workflowId: wf.id, runId: run.id });
      // Quiescence-done still counts as a close for Liana DM delivery (see completeRunFromMessage).
      void import("./liana").then((l) => l.onRunClosed(run.id)).catch((e) => console.error("liana delivery:", e));
      await completeOnceWorkflow(wf);
    } else if (run.status === "running" && idleMinutes >= WORKFLOW_STALL_MINUTES) {
      await db.setWorkflowRunStatus(run.id, "stalled");
      broadcastWorkspace(run.workspace_id, { type: "workflow_run_changed", workflowId: wf.id, runId: run.id });
      // One visible nudge in the run thread (never triggers agents: cascadeBudget 0).
      if (run.root_message_id && wf.home_channel_id) {
        try {
          const msg = await db.persistMessage({
            channelId: wf.home_channel_id,
            senderId: wf.roster[0]?.participant_id ?? "",
            body: `⚠️ This run looks stalled — no activity for ${Math.round(idleMinutes)} minutes. Nudge someone, or stop the run from the workflow page.`,
            threadRootId: run.root_message_id,
            cascadeBudget: 0,
          });
          await fanOut(wf.home_channel_id, { type: "message", message: att.withUrls(msg) });
        } catch (e) {
          console.error("stall nudge failed:", e);
        }
      }
    }
  }
}

// --- Pause / resume (active <-> paused; the backing schedule row pauses with it) ---

export async function setWorkflowPaused(wf: db.WorkflowRow, paused: boolean): Promise<db.WorkflowRow> {
  if (wf.status === "draft") throw new ApiError(400, "drafts can't be paused — finalize the workflow first");
  if (wf.status === "completed") throw new ApiError(400, "this one-time workflow has already run");
  const status = paused ? "paused" : "active";
  const backing = await db.getWorkflowBackingSchedule(wf.id);
  if (backing) {
    if (paused) {
      await db.setSchedulePaused(backing.id, new Date().toISOString());
    } else if (backing.cron) {
      await db.setSchedulePaused(backing.id, null, computeNextRun(backing.cron, backing.timezone!));
    }
  }
  const updated = (await db.updateWorkflow(wf.id, { status })) ?? wf;
  broadcastWorkspace(wf.workspace_id, { type: "workflow_changed", workflowId: wf.id, action: "updated" });
  return updated;
}
