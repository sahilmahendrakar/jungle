// Schedules: standing instructions that fire agent turns on a cadence — recurring (5-field cron
// evaluated in an IANA timezone) or one-shot (run_at). Created by agents (schedule_create tool)
// or humans (POST /api/schedules); managed by humans on the /scheduled page. A fired turn is a
// normal turn: the agent may send_message anywhere or legitimately say nothing. channel_id is
// only the schedule's dispatch context (confirm cards, default thread routing, notices).

export interface Schedule {
  id: string;
  workspace_id: string;
  agent_id: string;
  channel_id: string;
  created_by: string | null;
  prompt: string;
  // Exactly one cadence: recurring (cron + timezone, run_at null) or one-shot (run_at, cron null).
  cron: string | null;
  timezone: string | null;
  run_at: string | null;
  // null = will never fire again (completed one-shot). Paused schedules keep next_run_at but the
  // ticker skips them.
  next_run_at: string | null;
  paused_at: string | null;
  last_run_at: string | null;
  // 'pending' = fired, turn not yet finished; set to success/failure by turn-result attribution.
  last_status: "pending" | "success" | "failure" | null;
  last_error: string | null;
  failure_count: number;
  created_at: string;
  // Denormalized for list rendering (joined server-side by listWorkspaceSchedules).
  agent_handle?: string;
  agent_name?: string | null;
  channel_name?: string;
}
