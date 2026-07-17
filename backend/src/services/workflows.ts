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
import { broadcastWorkspace } from "../ws/appSocket";
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
