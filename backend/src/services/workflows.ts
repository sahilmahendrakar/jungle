import { randomBytes } from "node:crypto";
import {
  MAX_WORKFLOWS_PER_WORKSPACE,
  WORKFLOW_MAX_ROLES,
  WORKFLOW_NAME_MAX_LENGTH,
  WORKFLOW_PLAYBOOK_MAX_LENGTH,
  getWorkflowTemplate,
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
      handle_seed: role.handle_seed.trim().toLowerCase().slice(0, 32),
      duties: typeof role.duties === "string" ? role.duties.slice(0, 2000) : "",
      integrations: Array.isArray(role.integrations) ? role.integrations.filter((k) => typeof k === "string") : [],
      ...(role.participant_id ? { participant_id: String(role.participant_id) } : {}),
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
}): Promise<db.WorkflowRow> {
  const count = await db.countWorkspaceWorkflows(args.workspaceId);
  if (count >= MAX_WORKFLOWS_PER_WORKSPACE) {
    throw new ApiError(400, `this workspace already has ${count} workflows (max ${MAX_WORKFLOWS_PER_WORKSPACE})`);
  }
  const template = args.templateId ? getWorkflowTemplate(args.templateId) : undefined;
  if (args.templateId && !template) throw new ApiError(400, `unknown template ${JSON.stringify(args.templateId)}`);
  const row = await db.createWorkflow({
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
  broadcastWorkspace(args.workspaceId, { type: "workflow_changed", workflowId: row.id, action: "created" });
  return row;
}

// --- Finalize: draft -> active (the compile step: agents, channel, backing schedule) ---

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workflow"
  );
}

// Bind or create the agent for one roster role. Creating mirrors POST /api/agents (cap check in
// a workspace-locked transaction; provisioning fire-and-forget). Persona = the role's duties —
// the workflow section of the prompt (workflowPromptBlock) carries the playbook/roster, so the
// persona stays about WHO the agent is, not the process.
async function bindOrCreateMember(
  wf: db.WorkflowRow,
  role: WorkflowRole,
  taken: Set<string>,
): Promise<string> {
  if (role.participant_id) {
    const existing = await db.getParticipant(role.participant_id);
    if (!existing || existing.kind !== "agent" || existing.workspace_id !== wf.workspace_id) {
      throw new ApiError(400, `roster role "${role.role}": bound agent not found in this workspace`);
    }
    return existing.id;
  }
  // Pick a free handle: seed, then seed-2, seed-3, …
  let handle = role.handle_seed;
  for (let i = 2; taken.has(handle) || (await db.getParticipantByHandle(wf.workspace_id, handle)); i++) {
    handle = `${role.handle_seed}-${i}`;
    if (i > 50) throw new ApiError(500, "couldn't find a free handle");
  }
  taken.add(handle);
  const runnerToken = randomBytes(32).toString("hex");
  const participant = await db.withTransaction(async (client) => {
    const { count, cap } = await db.agentCountAndCap(client, wf.workspace_id);
    if (count >= cap) throw new ApiError(409, `this workspace has reached its agent limit (${cap})`);
    return db.createParticipant(
      {
        kind: "agent",
        workspaceId: wf.workspace_id,
        handle,
        displayName: role.role,
        runtime: "sdk",
        runnerToken,
        model: null,
        mode: "default",
        runnerProvider: "fly",
        persona: role.duties || null,
      },
      client,
    );
  });
  void (async () => {
    try {
      await provisionerFor(participant).create({ id: participant.id, handle, runnerToken });
      await provisionerFor(participant).start(participant.id);
      runners.noteProvisionerStart(participant.id);
    } catch (e) {
      console.error(`workflow ${wf.id}: provision member @${handle}:`, e);
    }
  })();
  return participant.id;
}

// The compile step: bind/create every roster agent, create (or adopt) the home channel, add
// members, create the backing schedule row for cron triggers, set active. Idempotent-ish: rerun
// after a failure just fills in what's missing (bound roles keep their agents).
export async function finalizeWorkflow(
  wf: db.WorkflowRow,
  actor: db.Participant,
  opts?: { homeChannelId?: string },
): Promise<db.WorkflowRow> {
  if (wf.status !== "draft") throw new ApiError(400, "workflow is already live");
  if (!wf.roster.length) throw new ApiError(400, "add at least one role to the roster first");

  // 1. Agents.
  const taken = new Set<string>();
  const roster: WorkflowRole[] = [];
  for (const role of wf.roster) {
    roster.push({ ...role, participant_id: await bindOrCreateMember(wf, role, taken) });
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

  // 4. Backing schedule for cron triggers (ticker branches on workflow_id — see scheduler.ts).
  const trigger = wf.trigger;
  if (trigger.type === "schedule") {
    const existing = await db.getWorkflowBackingSchedule(wf.id);
    if (!existing) {
      await db.createSchedule({
        workspaceId: wf.workspace_id,
        agentId: roster[0].participant_id!,
        channelId: homeChannelId!,
        createdBy: actor.id,
        prompt: `[workflow trigger] ${wf.name}`, // never dispatched as a prompt; ticker branches
        cron: trigger.cron,
        timezone: trigger.timezone,
        runAt: null,
        nextRunAt: computeNextRun(trigger.cron, trigger.timezone),
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

// --- Pause / resume (active <-> paused; the backing schedule row pauses with it) ---

export async function setWorkflowPaused(wf: db.WorkflowRow, paused: boolean): Promise<db.WorkflowRow> {
  if (wf.status === "draft") throw new ApiError(400, "drafts can't be paused — finalize the workflow first");
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
