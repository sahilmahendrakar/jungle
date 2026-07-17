// Workflows: a team of agents + a trigger + a prose playbook, packaged as one object the user
// can create from a template (or conversationally via the Architect) and observe as discrete
// runs. Deliberately minimal (see shared/docs/workflows-plan.md): the playbook is PROSE — there
// is no stage machine, no structured handoffs — and a run is just a thread in the workflow's
// home channel plus the member turns dispatched with that run's context. Workflows compile down
// to primitives that already exist (agents, channels, schedules, the cascade); the tables/types
// here only make the team legible and its runs observable.

// How a workflow starts a run. 'schedule' rides the existing schedules ticker (a backing
// schedules row with workflow_id set); 'manual' is the Run-now button; 'channel_message' means
// an @mention of the intake agent (roster[0]) in the home channel starts a run rooted at that
// message's thread. Every workflow also supports Run-now regardless of trigger type.
export type WorkflowTrigger =
  | { type: "schedule"; cron: string; timezone: string }
  | { type: "manual" }
  | { type: "channel_message" };

// One seat on the team. In a draft, participant_id may be unset (the agent doesn't exist yet);
// finalize binds every role to a participant — either an existing agent the user chose or a
// fresh one created from this seed. roster[0] is the intake role: it receives the kickoff turn.
export interface WorkflowRole {
  role: string; // human-readable seat name, e.g. "Inbox triage"
  handle_seed: string; // suggested agent handle when creating, e.g. "scout"
  duties: string; // prose duties, injected into the member's workflow prompt section
  integrations: string[]; // integration keys this seat wants connected (advisory, not enforced)
  participant_id?: string; // bound agent; unset only while status='draft'
}

export type WorkflowStatus = "draft" | "active" | "paused";

// The workflow object as sent to clients.
export interface Workflow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  emoji: string | null;
  status: WorkflowStatus;
  template_id: string | null; // the template this was instantiated from, if any
  home_channel_id: string | null; // null only while draft
  trigger: WorkflowTrigger;
  roster: WorkflowRole[];
  playbook: string; // prose: how the team works a run
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Denormalized for list rendering (joined server-side).
  home_channel_name?: string | null;
  next_run_at?: string | null; // from the backing schedule row (schedule triggers only)
  last_run?: WorkflowRun | null;
}

export type WorkflowRunStatus = "running" | "done" | "stalled" | "stopped";

// One firing of a workflow. The run's transcript is not stored here: it IS the thread under
// root_message_id plus the member turns whose dispatch context carries this run's id.
export interface WorkflowRun {
  id: string;
  workflow_id: string;
  workspace_id: string;
  trigger: "schedule" | "manual" | "channel_message";
  status: WorkflowRunStatus;
  root_message_id: string | null; // run-header message in the home channel (thread anchor)
  summary: string | null; // set by workflow_run_complete, the stop action, or quiescence
  started_at: string;
  ended_at: string | null;
}

// A run is live while running; stalled is still live (agents may resume it — completion or
// stop ends it), so the stall sweep and quiescence fallback keep watching stalled runs too.
export function isLiveRunStatus(s: WorkflowRunStatus): boolean {
  return s === "running" || s === "stalled";
}

// --- Limits (validated backend-side; mirrored here for client-side form hints) ---

export const WORKFLOW_NAME_MAX_LENGTH = 80;
export const WORKFLOW_PLAYBOOK_MAX_LENGTH = 8_000;
export const WORKFLOW_MAX_ROLES = 8;
export const MAX_WORKFLOWS_PER_WORKSPACE = 50;

// No member turn/thread activity for this long (with no pending confirmation) => stalled.
export const WORKFLOW_STALL_MINUTES = 15;
// All members idle + no activity for this long => the run quietly completes (fallback for a
// team that forgot to call workflow_run_complete).
export const WORKFLOW_QUIESCENCE_DONE_MINUTES = 30;
