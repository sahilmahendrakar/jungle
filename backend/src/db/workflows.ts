import type { PoolClient } from "pg";
import type { Workflow, WorkflowRole, WorkflowRun, WorkflowStatus, WorkflowTrigger } from "@jungle/shared";
import { pool } from "./pool";

// Workflows: plain data access (see migrations/026_workflows.sql). All validation and lifecycle
// logic (finalize, run start/complete, stall sweep) lives in services/workflows.ts.

// The DB row is exactly the wire shape minus the serializer-added denorms.
export type WorkflowRow = Omit<Workflow, "home_channel_name" | "next_run_at" | "last_run">;
export type WorkflowRunRow = WorkflowRun;

export async function createWorkflow(w: {
  workspaceId: string;
  name: string;
  description: string;
  emoji: string | null;
  status: WorkflowStatus;
  templateId: string | null;
  trigger: WorkflowTrigger;
  roster: WorkflowRole[];
  playbook: string;
  createdBy: string | null;
}): Promise<WorkflowRow> {
  const { rows } = await pool.query<WorkflowRow>(
    `insert into workflows
       (workspace_id, name, description, emoji, status, template_id, trigger, roster, playbook, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning *`,
    [
      w.workspaceId,
      w.name,
      w.description,
      w.emoji,
      w.status,
      w.templateId,
      JSON.stringify(w.trigger),
      JSON.stringify(w.roster),
      w.playbook,
      w.createdBy,
    ],
  );
  return rows[0];
}

export async function getWorkflow(id: string): Promise<WorkflowRow | null> {
  const { rows } = await pool.query<WorkflowRow>(`select * from workflows where id = $1`, [id]);
  return rows[0] ?? null;
}

// Workspace list for the Workflows page, denormalized with the home channel name, the backing
// schedule's next fire, and each workflow's most recent run.
export async function listWorkspaceWorkflows(
  workspaceId: string,
): Promise<(WorkflowRow & { home_channel_name: string | null; next_run_at: string | null; last_run: WorkflowRunRow | null })[]> {
  const { rows } = await pool.query<
    WorkflowRow & { home_channel_name: string | null; next_run_at: string | null; last_run: WorkflowRunRow | null }
  >(
    `select w.*,
            c.name as home_channel_name,
            s.next_run_at,
            (select to_jsonb(r) from workflow_runs r
              where r.workflow_id = w.id order by r.started_at desc limit 1) as last_run
     from workflows w
     left join channels c on c.id = w.home_channel_id
     left join schedules s on s.workflow_id = w.id
     where w.workspace_id = $1
     order by w.created_at desc`,
    [workspaceId],
  );
  return rows;
}

export async function updateWorkflow(
  id: string,
  patch: {
    name?: string;
    description?: string;
    emoji?: string | null;
    status?: WorkflowStatus;
    homeChannelId?: string | null;
    trigger?: WorkflowTrigger;
    roster?: WorkflowRole[];
    playbook?: string;
  },
): Promise<WorkflowRow | null> {
  const { rows } = await pool.query<WorkflowRow>(
    `update workflows set
       name            = coalesce($2, name),
       description     = coalesce($3, description),
       emoji           = case when $4 then $5 else emoji end,
       status          = coalesce($6, status),
       home_channel_id = case when $7 then $8::uuid else home_channel_id end,
       trigger         = coalesce($9::jsonb, trigger),
       roster          = coalesce($10::jsonb, roster),
       playbook        = coalesce($11, playbook),
       updated_at      = now()
     where id = $1
     returning *`,
    [
      id,
      patch.name ?? null,
      patch.description ?? null,
      patch.emoji !== undefined, // $4: emoji provided (may be null to clear)
      patch.emoji ?? null,
      patch.status ?? null,
      patch.homeChannelId !== undefined, // $7: home channel provided (may be null to clear)
      patch.homeChannelId ?? null,
      patch.trigger ? JSON.stringify(patch.trigger) : null,
      patch.roster ? JSON.stringify(patch.roster) : null,
      patch.playbook ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`delete from workflows where id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

export async function countWorkspaceWorkflows(workspaceId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*) as n from workflows where workspace_id = $1`,
    [workspaceId],
  );
  return Number(rows[0]?.n ?? 0);
}

// Workflows an agent sits in (roster jsonb containment) — powers the Team page grouping and the
// member-prompt section. Low frequency, so the jsonb scan is fine without an index.
export async function workflowsForParticipant(participantId: string): Promise<WorkflowRow[]> {
  const { rows } = await pool.query<WorkflowRow>(
    `select * from workflows
     where roster @> $1::jsonb
     order by created_at`,
    [JSON.stringify([{ participant_id: participantId }])],
  );
  return rows;
}

// --- Runs ---

export async function createWorkflowRun(r: {
  workflowId: string;
  workspaceId: string;
  trigger: WorkflowRun["trigger"];
  rootMessageId: string | null;
}): Promise<WorkflowRunRow> {
  const { rows } = await pool.query<WorkflowRunRow>(
    `insert into workflow_runs (workflow_id, workspace_id, trigger, root_message_id)
     values ($1, $2, $3, $4)
     returning *`,
    [r.workflowId, r.workspaceId, r.trigger, r.rootMessageId],
  );
  return rows[0];
}

export async function getWorkflowRun(id: string): Promise<WorkflowRunRow | null> {
  const { rows } = await pool.query<WorkflowRunRow>(`select * from workflow_runs where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listWorkflowRuns(workflowId: string, limit = 50): Promise<WorkflowRunRow[]> {
  const { rows } = await pool.query<WorkflowRunRow>(
    `select * from workflow_runs where workflow_id = $1 order by started_at desc limit $2`,
    [workflowId, limit],
  );
  return rows;
}

// Live (running|stalled) runs across all workspaces, for the stall/quiescence sweep.
export async function listLiveWorkflowRuns(): Promise<WorkflowRunRow[]> {
  const { rows } = await pool.query<WorkflowRunRow>(
    `select * from workflow_runs where status in ('running','stalled') order by started_at`,
  );
  return rows;
}

// A workflow's single live run, if any (one live run per workflow at a time — startRun refuses
// to stack a second; see services/workflows.ts).
export async function getLiveWorkflowRun(workflowId: string): Promise<WorkflowRunRow | null> {
  const { rows } = await pool.query<WorkflowRunRow>(
    `select * from workflow_runs
     where workflow_id = $1 and status in ('running','stalled')
     order by started_at desc limit 1`,
    [workflowId],
  );
  return rows[0] ?? null;
}

export async function setWorkflowRunRoot(id: string, rootMessageId: string): Promise<void> {
  await pool.query(`update workflow_runs set root_message_id = $2 where id = $1`, [id, rootMessageId]);
}

// Status transitions. Ending statuses stamp ended_at; a stalled->running revival clears it.
export async function setWorkflowRunStatus(
  id: string,
  status: WorkflowRun["status"],
  summary?: string | null,
): Promise<WorkflowRunRow | null> {
  const { rows } = await pool.query<WorkflowRunRow>(
    `update workflow_runs set
       status = $2,
       summary = coalesce($3, summary),
       ended_at = case when $2 in ('done','stopped') then now() else null end
     where id = $1
     returning *`,
    [id, status, summary ?? null],
  );
  return rows[0] ?? null;
}

// The most recent member activity for a run: the newest thread message under the run's root or
// inbox item carrying this run's context. Drives the stall/quiescence sweep. Falls back to
// started_at when nothing has happened yet.
export async function workflowRunLastActivity(run: WorkflowRunRow): Promise<string> {
  const { rows } = await pool.query<{ last: string | null }>(
    `select greatest(
       (select max(m.created_at) from messages m
         where m.thread_root_id = $2 or m.id = $2),
       (select max(i.created_at) from agent_inbox i
         where i.context->>'workflowRunId' = $1)
     ) as last`,
    [run.id, run.root_message_id],
  );
  return rows[0]?.last ?? run.started_at;
}

// --- Ticker helper (mirrors claimDueSchedules' locking discipline) ---

// Schedule rows that back workflow cron triggers are claimed by the same scheduler transaction;
// this resolves which workflow a claimed row fires (see services/scheduler.ts branch).
export async function getWorkflowForSchedule(client: PoolClient, scheduleId: string): Promise<WorkflowRow | null> {
  const { rows } = await client.query<WorkflowRow>(
    `select w.* from workflows w join schedules s on s.workflow_id = w.id where s.id = $1`,
    [scheduleId],
  );
  return rows[0] ?? null;
}
