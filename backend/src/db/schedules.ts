import type { PoolClient } from "pg";
import { pool } from "./pool";

// Schedules: standing instructions that fire agent turns on a cadence (see
// migrations/012_schedules.sql and services/scheduler.ts). All cadence/cap validation lives in
// the scheduler service — this module is plain data access.

export interface ScheduleRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  channel_id: string;
  created_by: string | null;
  prompt: string;
  cron: string | null;
  timezone: string | null;
  run_at: string | null;
  next_run_at: string | null;
  paused_at: string | null;
  last_run_at: string | null;
  last_status: "pending" | "success" | "failure" | null;
  last_error: string | null;
  failure_count: number;
  // Non-null = this row backs a workflow's schedule trigger: the ticker fires workflow dispatch
  // instead of a normal agent turn, and the row is hidden from schedule lists/caps.
  workflow_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function createSchedule(s: {
  workspaceId: string;
  agentId: string;
  channelId: string;
  createdBy: string | null;
  prompt: string;
  cron: string | null;
  timezone: string | null;
  runAt: string | null;
  nextRunAt: string;
  workflowId?: string; // backing row for a workflow's schedule trigger
}): Promise<ScheduleRow> {
  const { rows } = await pool.query<ScheduleRow>(
    `insert into schedules
       (workspace_id, agent_id, channel_id, created_by, prompt, cron, timezone, run_at, next_run_at, workflow_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning *`,
    [s.workspaceId, s.agentId, s.channelId, s.createdBy, s.prompt, s.cron, s.timezone, s.runAt, s.nextRunAt, s.workflowId ?? null],
  );
  return rows[0];
}

export async function getSchedule(id: string): Promise<ScheduleRow | null> {
  const { rows } = await pool.query<ScheduleRow>(`select * from schedules where id = $1`, [id]);
  return rows[0] ?? null;
}

// Workspace-wide list for the /scheduled page, denormalized with agent + channel names.
export async function listWorkspaceSchedules(
  workspaceId: string,
): Promise<(ScheduleRow & { agent_handle: string; agent_name: string | null; channel_name: string })[]> {
  const { rows } = await pool.query<ScheduleRow & { agent_handle: string; agent_name: string | null; channel_name: string }>(
    `select s.*, p.handle as agent_handle, p.display_name as agent_name, c.name as channel_name
     from schedules s
     join participants p on p.id = s.agent_id
     join channels c on c.id = s.channel_id
     where s.workspace_id = $1 and s.workflow_id is null
     order by s.created_at desc`,
    [workspaceId],
  );
  return rows;
}

export async function listAgentSchedules(agentId: string): Promise<ScheduleRow[]> {
  const { rows } = await pool.query<ScheduleRow>(
    `select * from schedules where agent_id = $1 and workflow_id is null order by created_at desc`,
    [agentId],
  );
  return rows;
}

// "Live" = could still fire: pending (next_run_at set) or paused. Completed one-shots don't
// count toward MAX_SCHEDULES_PER_AGENT.
export async function countLiveAgentSchedules(agentId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*) as n from schedules
     where agent_id = $1 and workflow_id is null
       and (next_run_at is not null or paused_at is not null)`,
    [agentId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function updateSchedule(
  id: string,
  patch: {
    prompt?: string;
    cron?: string | null;
    timezone?: string | null;
    runAt?: string | null;
    channelId?: string;
    nextRunAt?: string | null;
  },
): Promise<ScheduleRow | null> {
  const { rows } = await pool.query<ScheduleRow>(
    `update schedules set
       prompt      = coalesce($2, prompt),
       cron        = case when $7 then $3 else cron end,
       timezone    = case when $7 then $4 else timezone end,
       run_at      = case when $7 then $5::timestamptz else run_at end,
       next_run_at = case when $7 then $6::timestamptz else next_run_at end,
       channel_id  = coalesce($8, channel_id),
       failure_count = case when $7 then 0 else failure_count end,
       updated_at  = now()
     where id = $1
     returning *`,
    [
      id,
      patch.prompt ?? null,
      patch.cron ?? null,
      patch.timezone ?? null,
      patch.runAt ?? null,
      patch.nextRunAt ?? null,
      // $7: whether the cadence is being rewritten (cron/runAt/nextRunAt provided as a set).
      patch.nextRunAt !== undefined,
      patch.channelId ?? null,
    ],
  );
  return rows[0] ?? null;
}

// pausedAt non-null pauses; null resumes (with nextRunAt recomputed by the caller for resumes).
export async function setSchedulePaused(
  id: string,
  pausedAt: string | null,
  nextRunAt?: string | null,
): Promise<ScheduleRow | null> {
  const { rows } = await pool.query<ScheduleRow>(
    // $2 is cast explicitly: it appears both as an assignment target and in `is null`, so pg
    // can't otherwise infer its type ("could not determine data type of parameter $2").
    `update schedules set
       paused_at = $2::timestamptz,
       next_run_at = case when $3 then $4::timestamptz else next_run_at end,
       failure_count = case when $2::timestamptz is null then 0 else failure_count end,
       updated_at = now()
     where id = $1
     returning *`,
    [id, pausedAt, nextRunAt !== undefined, nextRunAt ?? null],
  );
  return rows[0] ?? null;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`delete from schedules where id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

// The backing row for a workflow's schedule trigger, if any.
export async function getWorkflowBackingSchedule(workflowId: string): Promise<ScheduleRow | null> {
  const { rows } = await pool.query<ScheduleRow>(
    `select * from schedules where workflow_id = $1 limit 1`,
    [workflowId],
  );
  return rows[0] ?? null;
}

// --- Ticker (run inside withTransaction; SKIP LOCKED so overlapping tickers claim disjoint rows) ---

export async function claimDueSchedules(client: PoolClient, limit = 20): Promise<ScheduleRow[]> {
  const { rows } = await client.query<ScheduleRow>(
    `select * from schedules
     where paused_at is null and next_run_at is not null and next_run_at <= now()
     order by next_run_at
     limit $1
     for update skip locked`,
    [limit],
  );
  return rows;
}

// Advance the cadence BEFORE dispatching (nextRunAt null completes a one-shot). last_status
// 'pending' until turn-result attribution lands.
export async function markScheduleFired(
  client: PoolClient,
  id: string,
  nextRunAt: string | null,
): Promise<void> {
  await client.query(
    `update schedules set next_run_at = $2, last_run_at = now(),
       last_status = 'pending', last_error = null, updated_at = now()
     where id = $1`,
    [id, nextRunAt],
  );
}

// --- Turn-result attribution (via agent_inbox.context->scheduleId + turn_id, see runners.ts) ---

export async function scheduleIdsForTurn(agentId: string, turnId: string): Promise<string[]> {
  const { rows } = await pool.query<{ schedule_id: string }>(
    `select distinct context->>'scheduleId' as schedule_id from agent_inbox
     where agent_id = $1 and turn_id = $2 and context ? 'scheduleId'`,
    [agentId, turnId],
  );
  return rows.map((r) => r.schedule_id);
}

export async function recordScheduleResult(
  id: string,
  ok: boolean,
  error: string | null,
): Promise<ScheduleRow | null> {
  const { rows } = await pool.query<ScheduleRow>(
    `update schedules set
       last_status = case when $2 then 'success' else 'failure' end,
       last_error = $3,
       failure_count = case when $2 then 0 else failure_count + 1 end,
       updated_at = now()
     where id = $1
     returning *`,
    [id, ok, error],
  );
  return rows[0] ?? null;
}
