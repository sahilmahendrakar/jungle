import * as db from "../db";
import * as att from "../attachments";
import { fanOut, DEFAULT_CASCADE_BUDGET } from "../ws/appSocket";
import { triggerMentionedAgents } from "./orchestrator";
import * as workflows from "./workflows";
import { ApiError } from "../http/errors";

// Channel + messaging management with an explicit ACTOR — the participant the operation runs as.
// One implementation behind both heads: the human REST routes (http/routes/channels.ts, where the
// actor is the Firebase-authed requester) and the /mcp server (where the actor is the API token's
// participant, human or agent). Everything here is workspace-scoped through the actor's row.

// Resolve a "#channel" (actor must be a member) or "@handle" (find-or-create the DM) destination
// to a channel id — the same routing rule the runner's send_message uses (orchestrator.ts).
export async function resolveDestination(
  actor: db.Participant,
  to: string,
): Promise<{ channelId: string } | { error: string }> {
  const dest = String(to ?? "").trim();
  if (dest.startsWith("#")) {
    const ch = await db.getChannelByNameForMember(dest.slice(1), actor.id);
    if (!ch) return { error: `you are not a member of channel ${dest} (or it doesn't exist)` };
    return { channelId: ch.id };
  }
  if (dest.startsWith("@")) {
    const other = await db.getParticipantByHandle(actor.workspace_id, dest.slice(1));
    if (!other) return { error: `no participant named ${dest}` };
    return { channelId: await db.findOrCreateDm(actor.id, other.id) };
  }
  return { error: `"to" must start with "#" (channel) or "@" (handle)` };
}

// Post a message as the actor: persist -> fan out -> cascade to any @mentioned agents. Starts a
// fresh cascade (DEFAULT_CASCADE_BUDGET) — a token-authed post is externally initiated, like a
// human typing, not a link in an existing agent-to-agent chain.
export async function postMessageAs(
  actor: db.Participant,
  input: { to: string; body: string; threadRootId?: string | null; alsoToChannel?: boolean },
): Promise<{ ok: true; messageId: string; channelId: string } | { ok: false; error: string }> {
  const body = String(input.body ?? "").trim();
  if (!body) return { ok: false, error: "body is required" };
  const dest = await resolveDestination(actor, input.to);
  if ("error" in dest) return { ok: false, error: dest.error };
  try {
    const msg = await db.persistMessage({
      channelId: dest.channelId,
      senderId: actor.id,
      body,
      cascadeBudget: DEFAULT_CASCADE_BUDGET,
      threadRootId: input.threadRootId ?? null,
      alsoToChannel: !!input.alsoToChannel,
    });
    await fanOut(dest.channelId, { type: "message", message: att.withUrls(msg) });
    // An agent actor's "Run complete: …" thread message still closes its workflow run.
    if (actor.kind === "agent") {
      void workflows.completeRunFromMessage(msg).catch((e) => console.error("run complete check:", e));
    }
    void triggerMentionedAgents(dest.channelId, msg, actor.kind === "agent" ? "agent" : "human");
    return { ok: true, messageId: msg.id, channelId: dest.channelId };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

// Create a channel; the actor is always a member. Extracted from POST /api/channels.
export async function createChannelAs(
  actor: db.Participant,
  input: { name: string; memberHandles?: string[] },
): Promise<{ id: string; name: string; kind: string }> {
  const name = String(input.name ?? "").trim().replace(/^#/, "");
  if (!name) throw new ApiError(400, "name required");
  const handles = (input.memberHandles ?? []).map((h) => String(h).replace(/^@/, ""));
  if (!handles.includes(actor.handle)) handles.push(actor.handle);
  return db.createChannel({ workspaceId: actor.workspace_id, name, kind: "channel", memberHandles: handles });
}

// Guard: the actor is a member of channel `id` (and it's in their workspace). Mirrors
// guards.requireChannelMember but takes an actor instead of an express request.
export async function requireChannelMemberAs(
  actor: db.Participant,
  channelId: string,
): Promise<{ id: string; name: string; kind: string; workspace_id: string }> {
  const channel = await db.getChannel(String(channelId));
  if (!channel || channel.workspace_id !== actor.workspace_id) throw new ApiError(404, "channel not found");
  if (!(await db.isMember(channel.id, actor.id))) throw new ApiError(403, "not a member of this channel");
  return channel;
}

// Add @handle to a channel the actor belongs to. Extracted from POST /api/channels/:id/members.
export async function addChannelMemberAs(
  actor: db.Participant,
  channelId: string,
  handle: string,
): Promise<db.Participant> {
  const channel = await requireChannelMemberAs(actor, channelId);
  if (channel.kind === "dm") throw new ApiError(400, "cannot change members of a DM");
  const clean = String(handle ?? "").trim().replace(/^@/, "");
  // Scope the handle lookup to the channel's workspace — you can't pull in someone from another.
  const target = await db.getParticipantByHandle(channel.workspace_id, clean);
  if (!target) throw new ApiError(404, `no participant @${clean}`);
  await db.addChannelMember(channel.id, target.id);
  await fanOut(channel.id, { type: "members_changed", channelId: channel.id });
  return target;
}

// Self-serve join: unlike addChannelMemberAs, the actor does NOT need to already be a member —
// channels have no public/private flag, so any channel in the actor's workspace is joinable.
// Extracted from POST /api/channels/:id/join.
export async function joinChannelAs(
  actor: db.Participant,
  channelId: string,
): Promise<{ id: string; name: string; kind: string }> {
  const channel = await db.getChannel(channelId);
  if (!channel || channel.workspace_id !== actor.workspace_id) throw new ApiError(404, "channel not found");
  if (channel.kind === "dm") throw new ApiError(400, "cannot join a DM");
  await db.addChannelMember(channel.id, actor.id);
  await fanOut(channel.id, { type: "members_changed", channelId: channel.id });
  return channel;
}

// Remove a member. Extracted from DELETE /api/channels/:id/members/:participantId.
export async function removeChannelMemberAs(
  actor: db.Participant,
  channelId: string,
  participantId: string,
): Promise<void> {
  const channel = await requireChannelMemberAs(actor, channelId);
  if (channel.kind === "dm") throw new ApiError(400, "cannot change members of a DM");
  // Notify (incl. the person being removed) before the row is gone, then remove.
  await fanOut(channel.id, { type: "members_changed", channelId: channel.id });
  await db.removeChannelMember(channel.id, participantId);
}
