import { CronExpressionParser } from "cron-parser";
import {
  MAX_SCHEDULES_PER_AGENT,
  MIN_SCHEDULE_INTERVAL_MINUTES,
  SCHEDULE_MAX_CONSECUTIVE_FAILURES,
  SCHEDULE_PROMPT_MAX_LENGTH,
} from "@jungle/shared";
import * as db from "../db";
import * as att from "../attachments";
import * as runners from "../runners";
import { provisionerFor } from "../provisioner";
import { fanOut, broadcastWorkspace, DEFAULT_CASCADE_BUDGET } from "../ws/appSocket";
import { ApiError } from "../http/errors";

// Schedules: standing instructions that fire agent turns on a cadence. This module owns
// validation (shared by the HTTP routes and the agent-tool hooks), the ticker that fires due
// schedules, and turn-result attribution (success/failure counters + auto-pause).
//
// A fired turn is dispatched through the exact pipeline a chat mention uses — durable inbox
// item (with dispatch context) -> drain -> wake-if-disconnected — so scheduled turns behave
// like any other turn: the agent may send_message anywhere, or legitimately say nothing.

// --- Validation ---

export interface ScheduleSpec {
  prompt: string;
  cron?: string;
  timezone?: string;
  runAt?: string;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Next fire time of `cron` evaluated in `tz`, from `from` (default now), as ISO.
export function computeNextRun(cron: string, tz: string, from?: Date): string {
  return CronExpressionParser.parse(cron, { tz, currentDate: from ?? new Date() })
    .next()
    .toDate()
    .toISOString();
}

// Validate a cadence spec and normalize it to columns + the first next_run_at.
// Throws ApiError(400) so HTTP routes can rethrow as-is; the tool hooks map it to {ok:false}.
export function validateScheduleSpec(spec: ScheduleSpec): {
  cron: string | null;
  timezone: string | null;
  runAt: string | null;
  nextRunAt: string;
} {
  const prompt = (spec.prompt ?? "").trim();
  if (!prompt) throw new ApiError(400, "prompt is required");
  if (prompt.length > SCHEDULE_PROMPT_MAX_LENGTH) {
    throw new ApiError(400, `prompt too long (max ${SCHEDULE_PROMPT_MAX_LENGTH} chars)`);
  }
  const hasCron = !!spec.cron;
  const hasRunAt = !!spec.runAt;
  if (hasCron === hasRunAt) {
    throw new ApiError(400, "provide exactly one cadence: cron+timezone (recurring) or runAt (one-time)");
  }
  if (hasCron) {
    const tz = spec.timezone ?? "";
    if (!tz || !isValidTimeZone(tz)) {
      throw new ApiError(400, `timezone must be a valid IANA timezone (got ${JSON.stringify(spec.timezone ?? null)})`);
    }
    let fires: Date[];
    try {
      const it = CronExpressionParser.parse(spec.cron!, { tz });
      // Sample the next few fires and require every consecutive gap to respect the minimum
      // interval. Exact minimal-gap analysis of an arbitrary cron is genuinely hard; sampling
      // catches every realistic dense pattern ("* * * * *", "*/5 …", minute lists) immediately,
      // while legitimate sparse crons (daily/weekly/monthly) trivially pass. DST shifts move
      // fires by whole hours — never under the minimum for an expression that passes here.
      fires = Array.from({ length: 5 }, () => it.next().toDate());
    } catch {
      throw new ApiError(400, `invalid cron expression ${JSON.stringify(spec.cron)} (expected 5-field cron)`);
    }
    const minGapMs = MIN_SCHEDULE_INTERVAL_MINUTES * 60_000;
    for (let i = 1; i < fires.length; i++) {
      if (fires[i].getTime() - fires[i - 1].getTime() < minGapMs) {
        throw new ApiError(400, `recurring schedules may fire at most every ${MIN_SCHEDULE_INTERVAL_MINUTES} minutes`);
      }
    }
    return { cron: spec.cron!, timezone: tz, runAt: null, nextRunAt: fires[0].toISOString() };
  }
  const runAt = new Date(spec.runAt!);
  if (Number.isNaN(runAt.getTime())) {
    throw new ApiError(400, `runAt must be an ISO-8601 timestamp (got ${JSON.stringify(spec.runAt)})`);
  }
  if (runAt.getTime() <= Date.now()) throw new ApiError(400, "runAt must be in the future");
  return { cron: null, timezone: null, runAt: runAt.toISOString(), nextRunAt: runAt.toISOString() };
}

// Human-readable cadence, used in prompts and announce messages.
export function cadenceText(s: Pick<db.ScheduleRow, "cron" | "timezone" | "run_at">): string {
  if (s.cron) return `recurring: cron "${s.cron}" in ${s.timezone}`;
  return `one-time, set for ${s.run_at}`;
}

// --- Create (shared by POST /api/schedules and the schedule_create tool hook) ---

export async function createScheduleChecked(args: {
  workspaceId: string;
  agentId: string;
  channelId: string;
  createdBy: string | null;
  spec: ScheduleSpec;
  // Agent-created schedules are announced with a persisted message in the context channel so a
  // standing spend is never invisible; human-created ones are visible by their own action.
  announce: boolean;
}): Promise<db.ScheduleRow> {
  const cadence = validateScheduleSpec(args.spec);
  const live = await db.countLiveAgentSchedules(args.agentId);
  if (live >= MAX_SCHEDULES_PER_AGENT) {
    throw new ApiError(400, `this agent already has ${live} schedules (max ${MAX_SCHEDULES_PER_AGENT}) — cancel one first`);
  }
  // Summon the agent into the context channel (same as an @mention does) so the scheduled
  // turn's to:"#channel" sends succeed even for human-created schedules.
  await db.addChannelMember(args.channelId, args.agentId);
  const row = await db.createSchedule({
    workspaceId: args.workspaceId,
    agentId: args.agentId,
    channelId: args.channelId,
    createdBy: args.createdBy,
    prompt: args.spec.prompt.trim(),
    ...cadence,
  });
  broadcastWorkspace(args.workspaceId, { type: "schedule_changed", scheduleId: row.id, action: "created" });
  if (args.announce) {
    try {
      const msg = await db.persistMessage({
        channelId: args.channelId,
        senderId: args.agentId,
        body:
          `🗓️ Scheduled: “${truncate(row.prompt, 120)}” — ${cadenceText(row)}. ` +
          `Next run: ${row.next_run_at}. Manage it on the Scheduled page.`,
        cascadeBudget: 0, // an announce must never trigger other agents
      });
      await fanOut(args.channelId, { type: "message", message: att.withUrls(msg) });
    } catch (e) {
      console.error("schedule announce failed:", e);
    }
  }
  return row;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// --- The ticker ---

const TICK_MS = Number(process.env.SCHEDULER_TICK_MS ?? 30_000);
let ticking = false;

export function startScheduler(): void {
  setInterval(() => {
    if (ticking) return; // re-entrancy guard, same pattern as runners.startIdleSweeper
    ticking = true;
    void tick()
      .catch((e) => console.error("scheduler tick:", e))
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS).unref();
}

async function tick(): Promise<void> {
  // Claim + advance in one transaction, COMMITTED BEFORE any dispatch: a crash mid-fire skips
  // that fire rather than double-firing. Missed fires while the backend was down coalesce into
  // at most one catch-up fire (computeNextRun advances from now, not the missed slot).
  // SKIP LOCKED lets overlapping tickers (future multi-backend) claim disjoint rows.
  const due = await db.withTransaction(async (client) => {
    const rows = await db.claimDueSchedules(client);
    for (const s of rows) {
      const next = s.cron ? computeNextRun(s.cron, s.timezone!) : null; // null completes a one-shot
      await db.markScheduleFired(client, s.id, next);
    }
    return rows;
  });
  for (const s of due) {
    try {
      await dispatchScheduledTurn(s);
    } catch (e) {
      console.error(`scheduler: dispatch failed for schedule ${s.id}:`, e);
    }
    broadcastWorkspace(s.workspace_id, { type: "schedule_changed", scheduleId: s.id, action: "updated" });
  }
}

// Fire one schedule: enqueue a self-contained turn (with dispatch context carrying the
// scheduleId for result attribution) and wake the runner — the same tail as a chat dispatch
// (orchestrator.ts's runAgentReply).
async function dispatchScheduledTurn(s: db.ScheduleRow): Promise<void> {
  const agent = await db.getAgentRow(s.agent_id);
  if (!agent) return;
  const channel = await db.getChannel(s.channel_id);
  if (!channel) return;
  const input = buildScheduledTurnInput(agent, s, channel.name);
  await db.enqueueInboxItem(agent.id, input, undefined, {
    budget: DEFAULT_CASCADE_BUDGET,
    channelId: s.channel_id,
    threadRootId: null,
    scheduleId: s.id,
  });
  await runners.drain(agent.id);
  if (!runners.isConnected(agent.id)) {
    try {
      await provisionerFor(agent).start(agent.id);
      runners.noteProvisionerStart(agent.id);
    } catch (e) {
      console.error(`scheduler: wake failed for ${agent.id}:`, e);
    }
  }
}

// The turn prompt is fully self-contained: the firing agent has no memory of the conversation
// where the schedule was created, and output is NOT forced — sending nothing is a normal outcome.
function buildScheduledTurnInput(agent: db.AgentRow, s: db.ScheduleRow, channelName: string): string {
  return (
    `You are @${agent.handle} in Jungle. This is a SCHEDULED turn — nobody just messaged you. ` +
    `A schedule (${cadenceText(s)}) fired. Its standing instruction is quoted verbatim below; ` +
    `you have no other memory of why it was created, so take it at face value:\n\n` +
    `>>> ${s.prompt}\n\n` +
    `The schedule's context channel is #${channelName}. If carrying this out produces something ` +
    `people should see, post it with send_message (to:"#${channelName}" unless the instruction ` +
    `says otherwise; prefer a thread for detail). If there is genuinely nothing worth reporting ` +
    `this time, finish WITHOUT sending any message — that is a normal outcome, don't post ` +
    `filler. If the instruction no longer makes sense, say so once in #${channelName} and cancel ` +
    `it with schedule_cancel (schedule id: ${s.id}).`
  );
}

// --- Turn-result attribution (wired as runners' onTurnFinished hook via orchestrator) ---

// Note: `fatal` frames carry no turnId, so a turn that dies fatally leaves the fire at
// 'pending' — accepted; the next fire proceeds normally.
export async function noteTurnResult(
  agentId: string,
  turnId: string,
  ok: boolean,
  error?: string,
): Promise<void> {
  const ids = await db.scheduleIdsForTurn(agentId, turnId);
  for (const id of ids) {
    const row = await db.recordScheduleResult(id, ok, ok ? null : (error ?? "unknown error"));
    if (!row) continue;
    if (!ok && !row.paused_at && row.failure_count >= SCHEDULE_MAX_CONSECUTIVE_FAILURES) {
      // Auto-pause a crash-looping schedule so it can't silently burn tokens forever, and say
      // so in the context channel (persisted, cascadeBudget 0 — must never trigger agents).
      await db.setSchedulePaused(id, new Date().toISOString());
      try {
        const msg = await db.persistMessage({
          channelId: row.channel_id,
          senderId: row.agent_id,
          body:
            `⏸️ I paused my schedule “${truncate(row.prompt, 80)}” after ` +
            `${SCHEDULE_MAX_CONSECUTIVE_FAILURES} consecutive failed runs ` +
            `(last error: \`${error ?? "unknown"}\`). Resume it from the Scheduled page.`,
          cascadeBudget: 0,
        });
        await fanOut(row.channel_id, { type: "message", message: att.withUrls(msg) });
      } catch (e) {
        console.error("schedule auto-pause notice failed:", e);
      }
    }
    broadcastWorkspace(row.workspace_id, { type: "schedule_changed", scheduleId: id, action: "updated" });
  }
}
