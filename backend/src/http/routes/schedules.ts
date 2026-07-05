import { Router } from "express";
import * as db from "../../db";
import { broadcastWorkspace } from "../../ws/appSocket";
import { wrap, ApiError } from "../errors";
import { requireRequester } from "../guards";
import * as scheduler from "../../services/scheduler";

// Human-facing schedule CRUD for the /scheduled page. Any workspace member may manage
// schedules (consistent with agents.ts, where members can create/delete whole agents).
// Agents manage their own via the schedule_* runner tools instead.

const router = Router();

// Load :id and 404 unless it's in the requester's workspace (defence in depth, same as
// requireChannelMember's workspace check).
async function requireSchedule(req: Parameters<typeof requireRequester>[0]) {
  const me = await requireRequester(req);
  const row = await db.getSchedule(String(req.params.id)).catch(() => null);
  if (!row || row.workspace_id !== me.workspace_id) throw new ApiError(404, "schedule not found");
  return { me, row };
}

router.get(
  "/api/schedules",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    res.json({ schedules: await db.listWorkspaceSchedules(me.workspace_id) });
  }),
);

router.post(
  "/api/schedules",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const { agentId, channelId, prompt, cron, timezone, runAt } = req.body ?? {};
    const agent = await db.getParticipant(String(agentId ?? ""));
    if (!agent || agent.kind !== "agent" || agent.workspace_id !== me.workspace_id) {
      throw new ApiError(404, "agent not found");
    }
    const channel = await db.getChannel(String(channelId ?? ""));
    if (!channel || channel.workspace_id !== me.workspace_id) throw new ApiError(404, "channel not found");
    const row = await scheduler.createScheduleChecked({
      workspaceId: me.workspace_id,
      agentId: agent.id,
      channelId: channel.id,
      createdBy: me.id,
      spec: { prompt: String(prompt ?? ""), cron, timezone, runAt },
      announce: false, // the human just did it themselves; no channel announce
    });
    res.status(201).json(row);
  }),
);

router.patch(
  "/api/schedules/:id",
  wrap(async (req, res) => {
    const { me, row } = await requireSchedule(req);
    const { prompt, cron, timezone, runAt, channelId, paused } = req.body ?? {};
    let updated = row;

    // Pause / resume.
    if (paused === true && !row.paused_at) {
      updated = (await db.setSchedulePaused(row.id, new Date().toISOString())) ?? updated;
    } else if (paused === false && row.paused_at) {
      // Resume: recompute the next fire. A one-shot whose time already passed can't resume.
      let nextRunAt: string;
      if (updated.cron) {
        nextRunAt = scheduler.computeNextRun(updated.cron, updated.timezone!);
      } else if (updated.run_at && new Date(updated.run_at).getTime() > Date.now()) {
        nextRunAt = updated.run_at;
      } else {
        throw new ApiError(400, "this one-time schedule's time has passed — edit runAt instead");
      }
      updated = (await db.setSchedulePaused(row.id, null, nextRunAt)) ?? updated;
    }

    // Prompt / cadence / channel edits.
    const patch: Parameters<typeof db.updateSchedule>[1] = {};
    if (prompt !== undefined) {
      const p = String(prompt).trim();
      if (!p) throw new ApiError(400, "prompt is required");
      patch.prompt = p;
    }
    if (channelId !== undefined) {
      const channel = await db.getChannel(String(channelId));
      if (!channel || channel.workspace_id !== me.workspace_id) throw new ApiError(404, "channel not found");
      await db.addChannelMember(channel.id, updated.agent_id); // summon, as on create
      patch.channelId = channel.id;
    }
    if (cron !== undefined || runAt !== undefined || timezone !== undefined) {
      // Rewriting the cadence revalidates the merged spec and recomputes next_run_at (also
      // resets failure_count — see db.updateSchedule).
      const cadence = scheduler.validateScheduleSpec({
        prompt: patch.prompt ?? updated.prompt,
        cron: cron !== undefined ? (cron || undefined) : (updated.cron ?? undefined),
        timezone: timezone !== undefined ? (timezone || undefined) : (updated.timezone ?? undefined),
        runAt: runAt !== undefined ? (runAt || undefined) : (updated.run_at ?? undefined),
      });
      patch.cron = cadence.cron;
      patch.timezone = cadence.timezone;
      patch.runAt = cadence.runAt;
      // While paused, don't schedule a fire — resume recomputes next_run_at. Otherwise apply
      // the freshly computed next fire immediately.
      patch.nextRunAt = updated.paused_at ? null : cadence.nextRunAt;
    }
    if (Object.keys(patch).length) {
      updated = (await db.updateSchedule(row.id, patch)) ?? updated;
    }

    broadcastWorkspace(me.workspace_id, { type: "schedule_changed", scheduleId: row.id, action: "updated" });
    res.json(updated);
  }),
);

router.delete(
  "/api/schedules/:id",
  wrap(async (req, res) => {
    const { me, row } = await requireSchedule(req);
    await db.deleteSchedule(row.id);
    broadcastWorkspace(me.workspace_id, { type: "schedule_changed", scheduleId: row.id, action: "deleted" });
    res.json({ ok: true });
  }),
);

export default router;
