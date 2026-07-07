import * as db from "../db";
import type { PersistedMessage } from "../db";
import * as att from "../attachments";
import * as runners from "../runners";
import { provisionerFor } from "../provisioner";
import { fanOut, broadcastWorkspace } from "../ws/appSocket";
import { surfaceConfirmCard } from "./confirmations";
import { recordDeliverables } from "./deliverables";
import * as scheduler from "./scheduler";
import { ApiError } from "../http/errors";

// Agent -> workspace id, memoized. An agent's workspace never changes, so this is a permanent
// cache. Used to scope the workspace-wide broadcasts (event/context/status) whose runner hooks
// only carry an agentId.
const agentWorkspaceCache = new Map<string, string>();
async function wsOf(agentId: string): Promise<string | null> {
  const cached = agentWorkspaceCache.get(agentId);
  if (cached) return cached;
  const ws = await db.getAgentWorkspaceId(agentId);
  if (ws) agentWorkspaceCache.set(agentId, ws);
  return ws;
}
function broadcastAgentWorkspace(agentId: string, payload: unknown): void {
  void wsOf(agentId).then((ws) => {
    if (ws) broadcastWorkspace(ws, payload);
  });
}

// The agent-cascade engine: when a message addresses agents, run their turns and post replies
// back (which may re-enter the cascade, bounded by cascade_budget). Also builds the RunnerHooks
// the runner subsystem calls back into.

// The dispatch context an agent's tool calls resolve against (cascade budget, trigger
// channel/thread): persisted on each inbox item at enqueue and read back from the most recently
// CONSUMED item. Durable across backend restarts, and immune to the enqueue-time clobber race
// the old in-memory per-agent map had (a dispatch queued behind a running turn only takes over
// once the runner actually consumes it).
async function resolveDispatchContext(agentId: string): Promise<db.DispatchContext | null> {
  return db.latestConsumedContext(agentId);
}

// Only the last few messages are inlined into the turn prompt — enough to orient the agent
// without ballooning prompt size as a channel/thread grows. The read_history tool pulls
// further back on demand.
const RECENT_CONTEXT_LIMIT = 5;

// Render the message that actually triggered this turn as its own emphasized block, clearly set
// apart from the surrounding context. Agents were observed latching onto an earlier, unrelated
// line in "recent conversation" and acting on that instead — this makes the actual task
// unambiguous even when it's buried near the bottom of a busy channel or thread.
function formatTriggerMessage(message: PersistedMessage): string {
  const attached = message.attachments?.length
    ? ` [attached: ${message.attachments.map((a) => a.filename).join(", ")}]`
    : "";
  return (
    `>>> THIS is the message that addressed you — it's what you're being asked to do. ` +
    `Everything above is background only.\n` +
    `@${message.sender_handle}: ${message.body}${attached}`
  );
}

// Compose the turn-input prompt for a dispatched agent: a one-line situation header (where +
// when — agents have no clock otherwise), a clearly-labeled context block, the emphasized
// trigger message, and the shape-specific routing footer. Three shapes:
//  - Existing thread: the agent gets the THREAD transcript; omitting threadRootId keeps its reply
//    in that thread (it can pass threadRootId:null / alsoToChannel to reach the whole channel).
//  - Top-level channel message: the agent gets recent channel context AND the triggering message's
//    id, and decides — pass that id as threadRootId to reply in a thread under it (encouraged, keeps
//    the channel tidy), or omit it to post a plain message to the channel.
//  - DM: recent context; reply goes top-level (DMs don't thread).
// General behavior (narrate progress, tone, threads-vs-channel philosophy) lives in the system
// prompt (runners.ts systemPromptAppend) — this footer carries only the routing facts that are
// concrete to THIS dispatch (channel name, thread root id).
async function buildAgentTurnInput(
  agent: db.AgentRow,
  triggerChannelId: string,
  triggerChannelName: string,
  existingThreadRootId: string | null,
  topLevelChannelMessageId: string | null,
  triggerMessage: PersistedMessage,
): Promise<string> {
  const triggerBlock = formatTriggerMessage(triggerMessage);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  if (existingThreadRootId) {
    return (
      `[Jungle turn] You (@${agent.handle}) were addressed in a THREAD in #${triggerChannelName} · now: ${now}\n\n` +
      `Thread so far (context):\n${await db.getThreadContext(existingThreadRootId, RECENT_CONTEXT_LIMIT)}\n\n` +
      `${triggerBlock}\n\n` +
      `Routing: send_message with to:"#${triggerChannelName}" — your reply stays in this thread ` +
      `automatically (progress updates and results go here). For something the whole channel ` +
      `should see, set alsoToChannel:true (posts to both) or threadRootId:null (channel only). ` +
      `DM someone with to:"@handle".`
    );
  }
  if (topLevelChannelMessageId) {
    return (
      `[Jungle turn] You (@${agent.handle}) were addressed in #${triggerChannelName} · now: ${now}\n\n` +
      `Recent conversation (context):\n${await db.getRecentContext(triggerChannelId, RECENT_CONTEXT_LIMIT)}\n\n` +
      `${triggerBlock}\n\n` +
      `Routing: send_message with to:"#${triggerChannelName}". Preferred: reply in a THREAD under ` +
      `the message that addressed you by passing threadRootId:"${topLevelChannelMessageId}" ` +
      `(progress updates go there too). Omit threadRootId only for a plain channel-level post. ` +
      `DM someone with to:"@handle", or post in another channel you belong to.`
    );
  }
  return (
    `[Jungle turn] You (@${agent.handle}) were addressed in a DM · now: ${now}\n\n` +
    `Recent conversation (context):\n${await db.getRecentContext(triggerChannelId, RECENT_CONTEXT_LIMIT)}\n\n` +
    `${triggerBlock}\n\n` +
    `Routing: reply with send_message to:"#${triggerChannelName}". ` +
    `You may also DM someone else with to:"@handle", or post in another channel you belong to.`
  );
}

// If a message addresses an agent (via @mention, or by being the other member of a DM, or a bare
// reply in a single-agent thread), run that agent's turn and post its reply back. Fire-and-forget
// so posting stays fast; the reply re-enters this function (agent->agent), gated by cascade_budget.
export async function triggerMentionedAgents(
  channelId: string,
  message: PersistedMessage,
  senderKind: "human" | "agent",
): Promise<void> {
  try {
    const budget = message.cascade_budget ?? 0;
    if (budget <= 0) return; // cascade exhausted — wait for a human to speak again
    const channel = await db.getChannel(channelId);
    if (!channel) return;
    const rootId = message.thread_root_id ?? null;

    // Explicit @mentions always route — in channels, DMs, and threads, agent→agent included
    // (cascade-bounded). Never self-trigger.
    let candidateIds = message.mentions.map((m) => m.id).filter((id) => id !== message.sender_id);

    // DM with no @mention: the other member (existing behavior).
    if (channel.kind === "dm" && !candidateIds.length) {
      candidateIds = (await db.channelMemberIds(channelId)).filter((id) => id !== message.sender_id);
    }

    // "No @ needed to reply to an agent" — THREADS ONLY. A bare (no-@) reply auto-wakes the
    // agent participating in the thread, but only when (a) the sender is HUMAN — otherwise two
    // agents in a thread would ping-pong (cascade budget bounds it, but we don't lean on that)
    // — and (b) EXACTLY ONE agent participates; 2+ is ambiguous, so require an @. The main
    // timeline is unaffected: replying to an agent there still needs an @.
    if (rootId && !candidateIds.length && senderKind === "human") {
      const threadAgents = (await db.agentIdsInThread(rootId)).filter((id) => id !== message.sender_id);
      if (threadAgents.length === 1) candidateIds = threadAgents;
    }

    // A top-level channel message the agent can choose to reply under as a thread root. We surface
    // this id to the agent (buildAgentTurnInput) and let it decide: pass it as threadRootId to
    // thread, or omit for a plain channel post. Null for DMs and for replies already in a thread
    // (those default back into the existing thread via rootId below).
    const topLevelChannelMessageId = rootId || channel.kind === "dm" ? null : message.id;

    const agents = await db.agentsByIds(candidateIds);
    for (const agent of agents) {
      // Summon the @mentioned agent into the channel so its reply (to:"#channel") succeeds
      // — otherwise mentioning an agent that isn't a member triggers it but it can't respond.
      await db.addChannelMember(channelId, agent.id);
      void runAgentReply(
        channelId, channel.name, agent, budget - 1, message.attachments, rootId, topLevelChannelMessageId,
        message,
      );
    }
  } catch (e) {
    console.error("triggerMentionedAgents:", e);
  }
}

async function runAgentReply(
  triggerChannelId: string,
  triggerChannelName: string,
  agent: db.AgentRow,
  replyBudget: number,
  attachments: db.AttachmentMeta[] = [],
  existingThreadRootId: string | null = null,
  topLevelChannelMessageId: string | null = null,
  triggerMessage: PersistedMessage,
): Promise<void> {
  // The agent's working/idle status is tracked from the runner's real turn lifecycle and
  // broadcast as agent_status_changed (see runners.ts) — no per-dispatch flash.
  try {
    const input = await buildAgentTurnInput(
      agent,
      triggerChannelId,
      triggerChannelName,
      existingThreadRootId,
      topLevelChannelMessageId,
      triggerMessage,
    );
    // Repo-specific working instructions live in the runner's systemPromptAppend (runners.ts).

    // Delivery is durable + asynchronous. The dispatch context (reply budget + the channel this
    // dispatch came from, so a send_message with no explicit destination and the confirm card land
    // in the right place + the EXISTING thread it was triggered in, if any, so an omitted
    // threadRootId defaults back into that thread) rides ON the inbox item and takes effect when
    // the runner consumes it. Enqueue the composed input and push it to the runner if one is
    // connected. If not, it waits in the inbox until the next `hello`.
    // If the agent is already busy, this dispatch will sit in the inbox until the current turn
    // ends (or splices it in mid-turn) — tell the workspace now so the triggering message shows
    // a "queued" chip immediately instead of nothing until a turn actually picks it up.
    const willQueue = runners.agentStatus(agent.id) === "working";
    await db.enqueueInboxItem(agent.id, input, attachments, {
      budget: replyBudget,
      channelId: triggerChannelId,
      threadRootId: existingThreadRootId,
      messageId: triggerMessage.id,
    });
    if (willQueue) {
      broadcastAgentWorkspace(agent.id, {
        type: "agent_queued",
        agentId: agent.id,
        context: {
          channelId: triggerChannelId,
          threadRootId: existingThreadRootId,
          messageId: triggerMessage.id,
        },
      });
    }
    await runners.drain(agent.id);
    // Wake-on-message: if the agent's machine is stopped/absent (idle-stop, or never started), a
    // disconnected runner won't have received the drain above — kick the provisioner so it comes
    // up and connects, at which point `hello` drains the real inbox.
    if (!runners.isConnected(agent.id)) {
      try {
        await provisionerFor(agent).start(agent.id);
        runners.noteProvisionerStart(agent.id);
      } catch (e) {
        console.error(`runAgentReply: wake failed for ${agent.id}:`, e);
      }
    }
  } catch (e) {
    console.error("runAgentReply:", e);
  }
}

// Execute one send_message tool call from an agent: resolve the destination (#channel or @handle),
// post via the routing rule (persist + fan out + cascade), and report back.
async function deliverAgentMessage(
  agent: { id: string; handle: string; workspace_id: string },
  toolInput: runners.SendMessageInput,
  budget: number,
  dispatch: { channelId?: string; threadRootId: string | null },
  turnId: string | null,
): Promise<runners.SendMessageResult> {
  const to = String(toolInput.to ?? "").trim();
  const body = String(toolInput.body ?? "").trim();
  // Attachment ids come from the runner's own uploads (POST /api/attachments with its runner
  // token). persistMessage only links ids this agent uploaded and hasn't sent yet.
  const attachmentIds = (Array.isArray(toolInput.attachmentIds) ? toolInput.attachmentIds : [])
    .map(String)
    .slice(0, att.MAX_ATTACHMENTS_PER_MESSAGE);
  if (!body && !attachmentIds.length) return { ok: false, error: "body is required" };

  let channelId: string;
  if (to.startsWith("#")) {
    const ch = await db.getChannelByNameForMember(to.slice(1), agent.id);
    if (!ch) return { ok: false, error: `you are not a member of channel ${to} (or it doesn't exist)` };
    channelId = ch.id;
  } else if (to.startsWith("@")) {
    // Scope the handle lookup to the agent's workspace — an agent can only DM its own workspace.
    const other = await db.getParticipantByHandle(agent.workspace_id, to.slice(1));
    if (!other) return { ok: false, error: `no participant named ${to}` };
    channelId = await db.findOrCreateDm(agent.id, other.id);
  } else {
    return { ok: false, error: `"to" must start with "#" (channel) or "@" (handle)` };
  }

  // Thread placement: honor an explicit threadRootId from the tool call; otherwise default to the
  // thread this agent was triggered in — but ONLY when replying back into that same channel (a DM
  // / different-channel send is never auto-threaded onto the trigger's root).
  const threadRootId =
    toolInput.threadRootId !== undefined
      ? toolInput.threadRootId
      : dispatch.channelId === channelId
        ? dispatch.threadRootId
        : null;

  try {
    const msg = await db.persistMessage({
      channelId, senderId: agent.id, body, cascadeBudget: budget, attachmentIds,
      threadRootId, alsoToChannel: !!toolInput.alsoToChannel, turnId,
    });
    await fanOut(channelId, { type: "message", message: att.withUrls(msg) });
    void recordDeliverables(agent, channelId, msg);
    void triggerMentionedAgents(channelId, msg, "agent");
    return { ok: true, messageId: msg.id };
  } catch (e) {
    // e.g. a stale/foreign threadRootId — report back so the agent can retry top-level.
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

// A runner's read_history call: same #channel/@handle destination resolution as
// deliverAgentMessage, but read-only — fetches a page of transcript older than `beforeSeq`
// (backend/db/{messages,threads}.ts's *HistoryBefore), or a specific thread's transcript when
// `threadRootId` is given. Backs the read_history tool, for context beyond the few messages
// inlined into the turn prompt (RECENT_CONTEXT_LIMIT above).
async function readAgentHistory(
  agent: { id: string; handle: string; workspace_id: string },
  toolInput: runners.ReadHistoryInput,
): Promise<runners.ReadHistoryResult> {
  const to = String(toolInput.to ?? "").trim();
  let channelId: string;
  if (to.startsWith("#")) {
    const ch = await db.getChannelByNameForMember(to.slice(1), agent.id);
    if (!ch) return { ok: false, error: `you are not a member of channel ${to} (or it doesn't exist)` };
    channelId = ch.id;
  } else if (to.startsWith("@")) {
    const other = await db.getParticipantByHandle(agent.workspace_id, to.slice(1));
    if (!other) return { ok: false, error: `no participant named ${to}` };
    channelId = await db.findOrCreateDm(agent.id, other.id);
  } else {
    return { ok: false, error: `"to" must start with "#" (channel) or "@" (handle)` };
  }

  const limit = Math.min(50, Math.max(1, Number(toolInput.limit) || 20));
  const beforeSeq = toolInput.beforeSeq ? String(toolInput.beforeSeq) : undefined;
  try {
    if (toolInput.threadRootId) {
      const rootChannel = await db.getMessageChannelId(toolInput.threadRootId);
      if (rootChannel !== channelId) return { ok: false, error: "that thread isn't in this channel" };
      const page = await db.getThreadHistoryBefore(toolInput.threadRootId, limit, beforeSeq);
      return { ok: true, text: page.text, oldestSeq: page.oldestSeq };
    }
    const page = await db.getChannelHistoryBefore(channelId, limit, beforeSeq);
    return { ok: true, text: page.text, oldestSeq: page.oldestSeq };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

// The chat-side effects the runner subsystem calls back into (wired via runners.init). Kept here
// so all cascade/dispatch logic lives in one module.
export function buildRunnerHooks(): runners.RunnerHooks {
  return {
    // A runner's send_message -> post it into Jungle, with the cascade budget of the dispatch
    // that triggered this agent (the most recently consumed inbox item's persisted context).
    deliverAgentMessage: async (agent, input, turnId) => {
      const ctx = await resolveDispatchContext(agent.id);
      return deliverAgentMessage(agent, input, ctx?.budget ?? 0, {
        channelId: ctx?.channelId,
        threadRootId: ctx?.threadRootId ?? null,
      }, turnId);
    },
    // A runner's read_history -> the same destination resolution as send_message, read-only.
    readHistory: (agent, input) => {
      return readAgentHistory(agent, input);
    },
    // A runner's schedule_create -> validate + insert via the scheduler service. The context
    // channel defaults to the channel this turn was dispatched from; "#name" resolves member-
    // scoped, same as send_message. ApiError messages surface to the agent as {ok:false}.
    scheduleCreate: async (agent, input) => {
      try {
        let channelId: string | undefined;
        const name = String(input.channel ?? "").trim();
        if (name) {
          const ch = await db.getChannelByNameForMember(name.replace(/^#/, ""), agent.id);
          if (!ch) return { ok: false, error: `you are not a member of channel ${name} (or it doesn't exist)` };
          channelId = ch.id;
        } else {
          channelId = (await resolveDispatchContext(agent.id))?.channelId;
          if (!channelId) return { ok: false, error: 'no channel context — pass channel:"#name"' };
        }
        const row = await scheduler.createScheduleChecked({
          workspaceId: agent.workspace_id,
          agentId: agent.id,
          channelId,
          createdBy: agent.id,
          spec: {
            prompt: String(input.prompt ?? ""),
            cron: input.cron,
            timezone: input.timezone,
            runAt: input.runAt,
          },
          announce: true,
        });
        return { ok: true, scheduleId: row.id, nextRunAt: row.next_run_at ?? undefined };
      } catch (e) {
        if (e instanceof ApiError) return { ok: false, error: e.message };
        throw e;
      }
    },
    // A runner's schedule_list -> the agent's own schedules as preformatted text.
    scheduleList: async (agent) => {
      const rows = await db.listAgentSchedules(agent.id);
      if (!rows.length) return { ok: true, text: "You have no schedules." };
      const lines = rows.map((s) => {
        const status = s.paused_at
          ? "PAUSED"
          : s.next_run_at
            ? `next run ${s.next_run_at}`
            : "completed";
        const last = s.last_status ? `, last run: ${s.last_status}` : "";
        const prompt = s.prompt.length > 80 ? s.prompt.slice(0, 79) + "…" : s.prompt;
        return `- ${s.id} [${scheduler.cadenceText(s)}] ${status}${last}\n  "${prompt}"`;
      });
      return { ok: true, text: `Your schedules:\n${lines.join("\n")}` };
    },
    // A runner's schedule_cancel -> delete, own schedules only.
    scheduleCancel: async (agent, input) => {
      const id = String(input.scheduleId ?? "").trim();
      if (!id) return { ok: false, error: "scheduleId is required" };
      const row = await db.getSchedule(id).catch(() => null);
      if (!row || row.agent_id !== agent.id) {
        return { ok: false, error: "no such schedule of yours (check schedule_list)" };
      }
      await db.deleteSchedule(id);
      broadcastWorkspace(row.workspace_id, { type: "schedule_changed", scheduleId: id, action: "deleted" });
      return { ok: true };
    },
    // Every turn_done -> attribute the result to any schedules whose fires fed the turn
    // (success/failure counters + auto-pause live in the scheduler), and close out the durable
    // turn row so a reload can show the chip as finished instead of forever "running".
    onTurnFinished: (agentId, turnId, ok, error) => {
      void scheduler.noteTurnResult(agentId, turnId, ok, error).catch((e) =>
        console.error("noteTurnResult:", e),
      );
      void db.finishTurn(agentId, turnId, ok).catch((e) => console.error("finishTurn:", e));
    },
    // A runner's confirm_request -> surface a confirmation card in the channel that triggered this
    // agent. Resolving the card resolves this promise; runners.ts relays it as confirm_result.
    requestConfirm: async (agent, confirm) => {
      const channelId = (await resolveDispatchContext(agent.id))?.channelId;
      if (!channelId) {
        // No known channel to place the card — deny rather than hang the turn.
        return { result: "deny" as const, denyMessage: "no channel context for confirmation" };
      }
      return surfaceConfirmCard(agent, channelId, confirm.toolName, confirm.input);
    },
    // A turn began -> persist the durable turn row (so a reload can hydrate its chip) and tell
    // the workspace where it was triggered from (channel/thread/message), so clients can show
    // the work where it was requested.
    onTurnStarted: (agentId, turnId, context) => {
      void db.ensureTurn(agentId, turnId, context).catch((e) => console.error("ensureTurn:", e));
      broadcastAgentWorkspace(agentId, {
        type: "agent_turn",
        agentId,
        turnId,
        context: context
          ? { channelId: context.channelId, threadRootId: context.threadRootId, messageId: context.messageId }
          : null,
      });
    },
    // A follow-up batch was consumed by a turn ALREADY in progress (spliced in, not queued for
    // its own turn) -> anchor its message to the same durable turn row. Only broadcast when the
    // anchor is genuinely new (ensureTurn is a no-op — and returns false — for the batch that
    // already anchored via onTurnStarted), so clients add this message to the same running/
    // finished chip instead of duplicating it.
    onTurnMessageJoined: (agentId, turnId, context) => {
      void db
        .ensureTurn(agentId, turnId, context)
        .then((added) => {
          if (!added) return;
          broadcastAgentWorkspace(agentId, {
            type: "agent_turn",
            agentId,
            turnId,
            context: { channelId: context.channelId, threadRootId: context.threadRootId, messageId: context.messageId },
          });
        })
        .catch((e) => console.error("ensureTurn (message joined):", e));
    },
    // A runner's SDK stream event -> persist for the Activity feed + broadcast to the agent's
    // workspace (raw tool output must never leak to other workspaces). The turn's context rides
    // on every frame so a client that loads mid-turn still learns the turn's home.
    onAgentEvent: (agentId, turnId, event, context) => {
      void db.insertAgentEvent(agentId, turnId, event).catch((e) => console.error("insertAgentEvent:", e));
      broadcastAgentWorkspace(agentId, {
        type: "agent_event",
        agentId,
        turnId,
        event,
        context: context
          ? { channelId: context.channelId, threadRootId: context.threadRootId, messageId: context.messageId }
          : null,
      });
    },
    // Per-turn context-window occupancy -> persist on the participant row + broadcast so an open
    // profile dialog's meter live-updates (workspace-scoped).
    onContextUsage: (agentId, usage) => {
      void db
        .updateAgentContextUsage(agentId, usage.tokens, usage.maxTokens)
        .catch((e) => console.error("updateAgentContextUsage:", e));
      broadcastAgentWorkspace(agentId, {
        type: "agent_context",
        agentId,
        tokens: usage.tokens,
        maxTokens: usage.maxTokens,
      });
    },
    // The agent's MEMORY.md changed -> persist the mirror + broadcast so an open profile
    // panel's Memory section live-updates (workspace-scoped). Content itself is fetched via
    // GET /api/agents/:id/memory, so the broadcast only signals "refetch".
    onMemoryUpdated: (agentId, content) => {
      void db
        .updateAgentMemory(agentId, content)
        .catch((e) => console.error("updateAgentMemory:", e));
      broadcastAgentWorkspace(agentId, { type: "agent_memory_changed", agentId });
    },
    // A turn crashed -> post a notice from the agent into the channel that triggered it so the
    // humans waiting aren't ghosted. cascadeBudget 0: a crash notice must never trigger others.
    onTurnFailed: (agent, error) => {
      void (async () => {
        const channelId = (await resolveDispatchContext(agent.id))?.channelId;
        if (!channelId) return;
        const msg = await db.persistMessage({
          channelId,
          senderId: agent.id,
          body: `⚠️ My turn crashed before I could finish (\`${error}\`). Any uncommitted work is still in my workspace — message me to pick it back up.`,
          cascadeBudget: 0,
        });
        await fanOut(channelId, { type: "message", message: att.withUrls(msg) });
      })().catch((e) => console.error("onTurnFailed:", e));
    },
    // The agent's live status changed -> broadcast to its workspace so every client's dot updates.
    onStatusChanged: (agentId, status) => {
      broadcastAgentWorkspace(agentId, { type: "agent_status_changed", agentId, status });
    },
  };
}
