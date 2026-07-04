import * as db from "../db";
import type { PersistedMessage } from "../db";
import * as att from "../attachments";
import * as runners from "../runners";
import { provisionerFor } from "../provisioner";
import { fanOut, broadcastWorkspace } from "../ws/appSocket";
import { surfaceConfirmCard } from "./confirmations";

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

// Per-agent context for the most recent sdk dispatch: the cascade budget its replies inherit, and
// the channel + thread it was triggered in (used to place a confirm card, and as a fallback
// destination). Overwritten each dispatch; sdk turns are serialized per agent by the runner.
const sdkContext = new Map<string, { budget: number; channelId: string; threadRootId: string | null }>();

// Compose the turn-input prompt for a dispatched agent. There are three shapes:
//  - Existing thread: the agent gets the THREAD transcript; omitting threadRootId keeps its reply
//    in that thread (it can pass threadRootId:null / alsoToChannel to reach the whole channel).
//  - Top-level channel message: the agent gets recent channel context AND the triggering message's
//    id, and decides — pass that id as threadRootId to reply in a thread under it (encouraged, keeps
//    the channel tidy), or omit it to post a plain message to the channel.
//  - DM: recent context; reply goes top-level (DMs don't thread).
async function buildAgentTurnInput(
  agent: db.AgentRow,
  triggerChannelId: string,
  triggerChannelName: string,
  existingThreadRootId: string | null,
  topLevelChannelMessageId: string | null,
): Promise<string> {
  if (existingThreadRootId) {
    return (
      `You are @${agent.handle} in Jungle. You were addressed in a thread in #${triggerChannelName}.\n\n` +
      `Thread so far:\n${await db.getThreadContext(existingThreadRootId)}\n\n` +
      `Reply by calling send_message with to:"#${triggerChannelName}" — your reply stays in this ` +
      `thread automatically, which is where your progress updates and results should go. Post ` +
      `frequent short updates as you work (e.g. "On it", your plan, what you're starting on). If a ` +
      `message is meant for the whole channel instead, set alsoToChannel:true (posts to both) or ` +
      `pass threadRootId:null (posts to the channel only). You may also DM someone with to:"@handle".`
    );
  }
  if (topLevelChannelMessageId) {
    return (
      `You are @${agent.handle} in Jungle. You were addressed in #${triggerChannelName} by message ` +
      `id ${topLevelChannelMessageId}.\n\n` +
      `Recent conversation:\n${await db.getRecentContext(triggerChannelId, 20)}\n\n` +
      `Reply by calling send_message with to:"#${triggerChannelName}". You decide where it lands: ` +
      `to reply in a THREAD under the message that addressed you (preferred — keeps the channel ` +
      `tidy, and where your progress updates should go), pass threadRootId:"${topLevelChannelMessageId}". ` +
      `To post a plain message to the whole channel instead, just omit threadRootId. Either way, ` +
      `send frequent short updates as you work (e.g. "On it — looking into this", "Here's my ` +
      `plan …", "Starting on the refactor …") rather than going silent until you're done. You may ` +
      `also DM someone with to:"@handle", or post in another channel you belong to.`
    );
  }
  return (
    `You are @${agent.handle} in Jungle. You were addressed in #${triggerChannelName}.\n\n` +
    `Recent conversation:\n${await db.getRecentContext(triggerChannelId, 20)}\n\n` +
    `Respond by calling send_message — to reply here use to:"#${triggerChannelName}". Send a short ` +
    `update as soon as you pick up non-trivial work, then brief progress notes as you go. ` +
    `You may also DM someone with to:"@handle", or post in another channel you belong to.`
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
    );
    // Repo-specific working instructions live in the runner's systemPromptAppend (runners.ts).

    // Delivery is durable + asynchronous. Remember the reply budget + the channel this dispatch
    // came from (so a send_message with no explicit destination, and the confirm card, land in the
    // right place) + the EXISTING thread it was triggered in, if any (so that when the agent omits
    // threadRootId its reply defaults back into that thread; for a top-level trigger there's no
    // default thread — the agent chooses by passing the message id). Enqueue the composed input and
    // push it to the runner if one is connected. If not, it waits in the inbox until the next `hello`.
    sdkContext.set(agent.id, {
      budget: replyBudget,
      channelId: triggerChannelId,
      threadRootId: existingThreadRootId,
    });
    await db.enqueueInboxItem(agent.id, input, attachments);
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
      threadRootId, alsoToChannel: !!toolInput.alsoToChannel,
    });
    await fanOut(channelId, { type: "message", message: att.withUrls(msg) });
    void triggerMentionedAgents(channelId, msg, "agent");
    return { ok: true, messageId: msg.id };
  } catch (e) {
    // e.g. a stale/foreign threadRootId — report back so the agent can retry top-level.
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

// The chat-side effects the runner subsystem calls back into (wired via runners.init). Kept here
// so all cascade/dispatch logic lives in one module.
export function buildRunnerHooks(): runners.RunnerHooks {
  return {
    // A runner's send_message -> post it into Jungle, with the cascade budget of the dispatch
    // that triggered this agent (looked up from sdkContext).
    deliverAgentMessage: (agent, input) => {
      const ctx = sdkContext.get(agent.id);
      return deliverAgentMessage(agent, input, ctx?.budget ?? 0, {
        channelId: ctx?.channelId,
        threadRootId: ctx?.threadRootId ?? null,
      });
    },
    // A runner's confirm_request -> surface a confirmation card in the channel that triggered this
    // agent. Resolving the card resolves this promise; runners.ts relays it as confirm_result.
    requestConfirm: (agent, confirm) => {
      const channelId = sdkContext.get(agent.id)?.channelId;
      if (!channelId) {
        // No known channel to place the card — deny rather than hang the turn.
        return Promise.resolve({ result: "deny", denyMessage: "no channel context for confirmation" });
      }
      return surfaceConfirmCard(agent, channelId, confirm.toolName, confirm.input);
    },
    // A runner's SDK stream event -> persist for the Activity feed + broadcast to the agent's
    // workspace (raw tool output must never leak to other workspaces).
    onAgentEvent: (agentId, turnId, event) => {
      void db.insertAgentEvent(agentId, turnId, event).catch((e) => console.error("insertAgentEvent:", e));
      broadcastAgentWorkspace(agentId, { type: "agent_event", agentId, turnId, event });
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
    // A turn crashed -> post a notice from the agent into the channel that triggered it so the
    // humans waiting aren't ghosted. cascadeBudget 0: a crash notice must never trigger others.
    onTurnFailed: (agent, error) => {
      const channelId = sdkContext.get(agent.id)?.channelId;
      if (!channelId) return;
      void (async () => {
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
