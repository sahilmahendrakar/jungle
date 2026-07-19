// Workflow presentation helpers — trigger copy ported verbatim from the web's
// WorkflowCanvas.tsx so both clients describe a trigger with the same words.
import type { Workflow, WorkflowRun } from "@jungle/shared";
import { isLiveRunStatus } from "@jungle/shared";
import type { IoniconName } from "./icons";

const HOUR_LABEL = (h: number) =>
  h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;

// Parse the friendly cron shape ("M H * * D") the trigger editor writes; null for exotic crons.
function parseSimpleCron(cron: string): { hour: number; days: string } | null {
  const p = cron.split(" ");
  if (p.length !== 5 || p[2] !== "*" || p[3] !== "*" || !/^\d+$/.test(p[1])) return null;
  return { hour: Number(p[1]), days: p[4] };
}

// One plain-English line for headers: "Every weekday at 8 AM (Los Angeles)".
export function triggerSentence(w: Workflow): string {
  const t = w.trigger;
  if (t.type === "schedule") {
    const c = parseSimpleCron(t.cron);
    const tz = t.timezone.split("/").pop()?.replace(/_/g, " ") ?? t.timezone;
    return c
      ? `${c.days === "1-5" ? "Every weekday" : c.days === "*" ? "Every day" : "On a schedule"} at ${HOUR_LABEL(c.hour)} (${tz})`
      : `On a schedule (${t.cron})`;
  }
  if (t.type === "channel_message") return "Starts from a message";
  return "Runs when you press Run now";
}

// Compact icon + text for list rows.
export function triggerLabel(w: Workflow): { icon: IoniconName; text: string } {
  const t = w.trigger;
  if (t.type === "schedule") return { icon: "calendar-outline", text: "On a schedule" };
  if (t.type === "channel_message") return { icon: "chatbubble-outline", text: "Starts from a message" };
  return { icon: "flash-outline", text: "Run manually" };
}

export function liveRunOf(w: Workflow): WorkflowRun | null {
  return w.last_run && isLiveRunStatus(w.last_run.status) ? w.last_run : null;
}

// Status pill copy + tint role. "Running" wins over "Active" when a run is live.
export function workflowStatusMeta(w: Workflow): { label: string; tone: "live" | "active" | "muted" } {
  if (w.status === "draft") return { label: "Draft", tone: "muted" };
  if (w.status === "paused") return { label: "Paused", tone: "muted" };
  if (liveRunOf(w)) return { label: "Running", tone: "live" };
  return { label: "Active", tone: "active" };
}

export function runStatusMeta(status: WorkflowRun["status"]): { label: string; tone: "live" | "active" | "muted" | "warn" } {
  if (status === "running") return { label: "Running", tone: "live" };
  if (status === "stalled") return { label: "Stalled", tone: "warn" };
  if (status === "stopped") return { label: "Stopped", tone: "muted" };
  return { label: "Done", tone: "active" };
}

export function runDuration(r: WorkflowRun): string {
  const end = r.ended_at ? new Date(r.ended_at).getTime() : Date.now();
  const mins = Math.max(1, Math.round((end - new Date(r.started_at).getTime()) / 60_000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
