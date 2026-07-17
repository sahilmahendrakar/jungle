import { Router } from "express";
import { WORKFLOW_TEMPLATES } from "@jungle/shared";
import * as db from "../../db";
import { broadcastWorkspace } from "../../ws/appSocket";
import { wrap, ApiError } from "../errors";
import { requireRequester } from "../guards";
import * as workflows from "../../services/workflows";

// Workflow CRUD for the Workflows page + builder. Any workspace member may manage workflows
// (consistent with schedules/agents). Deleting a workflow removes the object, its runs, and its
// backing schedule (FK cascade) but deliberately leaves the member agents and home channel alive
// — they're real things the user may keep; cleaning them up is an explicit, separate act.

const router = Router();

async function requireWorkflow(req: Parameters<typeof requireRequester>[0]) {
  const me = await requireRequester(req);
  const row = await db.getWorkflow(String(req.params.id)).catch(() => null);
  if (!row || row.workspace_id !== me.workspace_id) throw new ApiError(404, "workflow not found");
  return { me, row };
}

router.get(
  "/api/workflow-templates",
  wrap(async (_req, res) => {
    res.json({ templates: WORKFLOW_TEMPLATES });
  }),
);

router.get(
  "/api/workflows",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    res.json({ workflows: await db.listWorkspaceWorkflows(me.workspace_id) });
  }),
);

router.get(
  "/api/workflows/:id",
  wrap(async (req, res) => {
    const { row } = await requireWorkflow(req);
    res.json(row);
  }),
);

router.get(
  "/api/workflows/:id/runs",
  wrap(async (req, res) => {
    const { row } = await requireWorkflow(req);
    res.json({ runs: await db.listWorkflowRuns(row.id) });
  }),
);

// Create a draft — blank or pre-filled from a template. Finalizing (creating/binding agents,
// the home channel, the backing schedule) is a separate POST /api/workflows/:id/finalize.
router.post(
  "/api/workflows",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const { templateId, name } = req.body ?? {};
    const row = await workflows.createDraft({
      workspaceId: me.workspace_id,
      createdBy: me.id,
      templateId: templateId ? String(templateId) : undefined,
      name: name ? String(name) : undefined,
    });
    res.status(201).json(row);
  }),
);

router.patch(
  "/api/workflows/:id",
  wrap(async (req, res) => {
    const { me, row } = await requireWorkflow(req);
    const { name, description, emoji, playbook, roster, trigger, paused } = req.body ?? {};

    let updated = row;
    if (paused !== undefined) {
      updated = await workflows.setWorkflowPaused(updated, Boolean(paused));
    }

    const patch: Parameters<typeof db.updateWorkflow>[1] = {};
    if (name !== undefined) patch.name = workflows.validateName(name);
    if (description !== undefined) patch.description = String(description).slice(0, 500);
    if (emoji !== undefined) patch.emoji = emoji ? String(emoji).slice(0, 8) : null;
    if (playbook !== undefined) patch.playbook = workflows.validatePlaybook(playbook);
    if (roster !== undefined) patch.roster = workflows.validateRoster(roster);
    if (trigger !== undefined) {
      // Trigger edits on a live workflow require re-syncing the backing schedule; that lands
      // with finalize. Drafts can change trigger freely.
      if (updated.status !== "draft") throw new ApiError(400, "change the trigger from the workflow's builder (drafts only for now)");
      patch.trigger = workflows.validateTrigger(trigger);
    }
    if (Object.keys(patch).length) {
      updated = (await db.updateWorkflow(row.id, patch)) ?? updated;
      broadcastWorkspace(me.workspace_id, { type: "workflow_changed", workflowId: row.id, action: "updated" });
    }
    res.json(updated);
  }),
);

router.delete(
  "/api/workflows/:id",
  wrap(async (req, res) => {
    const { me, row } = await requireWorkflow(req);
    await db.deleteWorkflow(row.id);
    broadcastWorkspace(me.workspace_id, { type: "workflow_changed", workflowId: row.id, action: "deleted" });
    res.json({ ok: true });
  }),
);

export default router;
