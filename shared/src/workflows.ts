// Workflows: a team of agents + a trigger + a prose playbook, packaged as one object the user
// can create from a template (or conversationally via the Architect) and observe as discrete
// runs. Deliberately minimal (see shared/docs/workflows-plan.md): the playbook is PROSE — there
// is no stage machine, no structured handoffs — and a run is just a thread in the workflow's
// home channel plus the member turns dispatched with that run's context. Workflows compile down
// to primitives that already exist (agents, channels, schedules, the cascade); the tables/types
// here only make the team legible and its runs observable.

// How a workflow starts a run. 'schedule' rides the existing schedules ticker (a backing
// schedules row with workflow_id set); 'once' is a one-shot at a specific absolute time (a
// backing schedules row with run_at set — the ticker fires it once, then next_run_at goes null
// and the workflow moves to status 'completed'); 'manual' is the Run-now button; 'channel_message'
// means an @mention of the intake agent (roster[0]) in the home channel starts a run rooted at
// that message's thread. Every workflow also supports Run-now regardless of trigger type.
// For 'once', runAt is an absolute ISO timestamp; timezone is retained for human-readable display.
export type WorkflowTrigger =
  | { type: "schedule"; cron: string; timezone: string }
  | { type: "once"; runAt: string; timezone: string }
  | { type: "manual" }
  | { type: "channel_message" };

// One seat on the team. In a draft, participant_id is unset (the agent doesn't exist yet);
// finalize creates a fresh agent per seat. roster[0] is the intake role: it receives the
// kickoff turn. Seats get a Jungle animal identity (AGENT_PRESETS) when the draft is created,
// so the builder shows the actual teammates you'll get.
export interface WorkflowRole {
  role: string; // seat title, e.g. "Inbox triage"
  name?: string; // agent display name, e.g. "Finn the Fox" (preset-assigned at draft creation)
  handle_seed: string; // the agent handle to create, e.g. "finn-the-fox"
  duties: string; // the seat's instructions — becomes the agent's persona
  integrations: string[]; // integration keys attached to the created agent (gmail, github, …)
  repo?: string; // owner/name — the GitHub repo, when integrations includes "github"
  participant_id?: string; // the created agent; unset while status='draft'
  // Presentation-only layout hints for the canvas — they do NOT affect execution (the playbook
  // does). Roles sharing a stage render stacked in parallel; edge_label captions the connectors
  // arriving at this role's stage (e.g. "assigns"). Unset stage = one stage after the previous
  // role, so plain rosters render as a left-to-right chain.
  stage?: number;
  edge_label?: string;
}

// 'completed' is terminal: a 'once' workflow that has fired its single run. It stays in the list
// (its run output is useful history) but is inert — no schedule, not pausable.
export type WorkflowStatus = "draft" | "active" | "paused" | "completed";

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
