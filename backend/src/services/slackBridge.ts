import type { SlackChannelLink } from "@jungle/shared";
import * as db from "../db";
import * as att from "../attachments";
import * as slack from "../slack/api";
import { slackToJungleText, jungleToSlackText, mentionedSlackUserIds } from "../slack/format";
import { fanOut, broadcastWorkspace, DEFAULT_CASCADE_BUDGET } from "../ws/appSocket";
import { triggerMentionedAgents } from "./orchestrator";
import { ApiError } from "../http/errors";

// The Slack <-> Jungle bridge. Ingress (processSlackEvent): a verified Slack event becomes a Jungle
// message from a shadow/linked participant, triggering the normal agent cascade. Egress
// (startSlackOutbox): a ticker drains slack_outbox (enqueued transactionally in persistMessage) to
// chat.postMessage. Plus link/unlink/status/list helpers used by http/routes/slack.ts.
//
// Echo suppression is structural: ingested messages carry origin:"slack" (skips outbox enqueue),
// and our own posts arrive back with a bot_id (dropped on ingress).

// --- Wire mapping ---

function toWireLink(row: db.SlackChannelLinkRow): SlackChannelLink {
  return {
    channelId: row.jungle_channel_id,
    slackChannelId: row.slack_channel_id,
    slackChannelName: row.slack_channel_name,
    status: row.status,
    lastError: row.last_error,
  };
}

function broadcastLink(row: db.SlackChannelLinkRow): void {
  broadcastWorkspace(row.workspace_id, {
    type: "slack_link_changed",
    channelId: row.jungle_channel_id,
    link: toWireLink(row),
  });
}

// ============================ INGRESS ============================

// Slack subtypes we mirror. Everything else (message_changed, message_deleted, channel_join,
// bot_message, …) is dropped — Jungle is insert-only and v1 excludes edits/deletes.
const MIRRORED_SUBTYPES = new Set([undefined, "file_share", "thread_broadcast"] as (string | undefined)[]);

interface SlackEventEnvelope {
  type?: string;
  event_id?: string;
  team_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    user?: string;
    bot_id?: string;
    channel?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    files?: { name?: string; title?: string }[];
  };
}

// Process one Events API callback. Called AFTER the route has acked 200 (so this can take its time
// and the fire-and-forget agent cascade runs safely). Self-contained error handling — never throws
// back to the route.
export async function processSlackEvent(payload: SlackEventEnvelope): Promise<void> {
  if (payload.type !== "event_callback" || !payload.event_id || !payload.team_id) return;
  const ev = payload.event;
  if (!ev || ev.type !== "message" || !ev.channel || !ev.ts) return;
  if (!MIRRORED_SUBTYPES.has(ev.subtype)) return;

  // Dedupe (Events API is at-least-once). recordSlackEvent returns false if already seen.
  if (!(await db.recordSlackEvent(payload.event_id))) return;

  const install = await db.getSlackInstallByTeam(payload.team_id);
  if (!install || install.status !== "active") return;

  // Echo drop: our own posts (and any other bot's messages) carry a bot_id; also guard on our
  // bot user id. This is what makes round-trips loop-free.
  if (ev.bot_id || !ev.user || ev.user === install.bot_user_id) return;

  const link = await db.getLinkBySlackChannel(payload.team_id, ev.channel);
  if (!link || link.status !== "active") return;

  const sender = await getOrCreateSlackParticipant(install, link, ev.user);
  if (!sender) return;

  // Thread mapping: a Slack reply targets the Jungle message the root maps to (top-level if the
  // root predates the link). thread_broadcast also echoes into the main timeline.
  let threadRootId: string | null = null;
  if (ev.thread_ts && ev.thread_ts !== ev.ts) {
    const rootLink = await db.getMessageLinkBySlackTs(payload.team_id, ev.channel, ev.thread_ts);
    threadRootId = rootLink?.jungle_message_id ?? null;
  }
  const alsoToChannel = ev.subtype === "thread_broadcast";

  const body = await buildBody(payload.team_id, ev);

  // Persist -> fan out -> trigger agents: the exact trio a human WS post runs. origin:"slack"
  // suppresses the outbox (no echo). Plaintext @agentname in `body` triggers the cascade via
  // resolveMentions; a thread reply carries threadRootId so the agent answers back in-thread.
  const msg = await db.persistMessage({
    channelId: link.jungle_channel_id,
    senderId: sender.id,
    body,
    clientMsgId: `slack:${payload.team_id}:${ev.channel}:${ev.ts}`,
    cascadeBudget: DEFAULT_CASCADE_BUDGET,
    threadRootId,
    alsoToChannel,
    origin: "slack",
  });
  await db.insertMessageLink({
    jungleMessageId: msg.id,
    teamId: payload.team_id,
    slackChannelId: ev.channel,
    slackTs: ev.ts,
    slackThreadTs: ev.thread_ts ?? null,
    origin: "slack",
  });
  await fanOut(link.jungle_channel_id, { type: "message", message: att.withUrls(msg) });
  void triggerMentionedAgents(link.jungle_channel_id, msg, "human");
}

// Convert the Slack text (resolving @-mentions of KNOWN participants to @handle) and append file
// notes (v1 mirrors files as a text note, not the bytes).
async function buildBody(teamId: string, ev: NonNullable<SlackEventEnvelope["event"]>): Promise<string> {
  const text = ev.text ?? "";
  const map = new Map<string, string>();
  for (const id of mentionedSlackUserIds(text)) {
    const l = await db.getUserLink(teamId, id);
    if (l) {
      const p = await db.getParticipant(l.participant_id);
      if (p) map.set(id, p.handle);
    }
  }
  let body = slackToJungleText(text, (id) => map.get(id) ?? null);
  for (const f of ev.files ?? []) {
    body += `\n📎 shared a file: ${f.name || f.title || "file"}`;
  }
  return body.trim() || "(empty message)";
}

// Resolve a Slack user to a Jungle participant, creating a shadow the first time. Email-matches an
// existing workspace human when possible (so their Slack messages attribute to their real account).
async function getOrCreateSlackParticipant(
  install: db.SlackInstall,
  link: db.SlackChannelLinkRow,
  slackUserId: string,
): Promise<db.Participant | null> {
  const existing = await db.getUserLink(install.team_id, slackUserId);
  if (existing) {
    const p = await db.getParticipant(existing.participant_id);
    if (p) {
      await db.addChannelMember(link.jungle_channel_id, p.id);
      return p;
    }
    // Link dangles (participant deleted) — fall through and recreate.
  }

  let profile: slack.SlackUserProfile;
  try {
    profile = await slack.usersInfo(install.bot_token, slackUserId);
  } catch (e) {
    console.error("slack: users.info failed", slackUserId, e);
    return null;
  }

  // Email auto-linking to a real Jungle human.
  if (profile.email) {
    const human = await db.getParticipantByEmail(install.workspace_id, profile.email);
    if (human) {
      await db.insertUserLink({ teamId: install.team_id, slackUserId, participantId: human.id, kind: "linked" });
      await db.addChannelMember(link.jungle_channel_id, human.id);
      return human;
    }
  }

  // Shadow participant.
  const handle = await uniqueHandle(install.workspace_id, profile.displayName);
  const shadow = await db.createParticipant({
    kind: "human",
    workspaceId: install.workspace_id,
    handle,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    email: profile.email,
    firebaseUid: null,
  });
  await db.insertUserLink({ teamId: install.team_id, slackUserId, participantId: shadow.id, kind: "shadow" });
  await db.addChannelMember(link.jungle_channel_id, shadow.id);
  return shadow;
}

// Slugify a Slack display name into the mention charset [a-zA-Z0-9_-] and make it unique in the
// workspace with a numeric suffix (handles are case-insensitively unique per workspace).
// Exported for the Liana service, which creates shadow participants the same way.
export async function uniqueHandle(workspaceId: string, displayName: string): Promise<string> {
  let base = displayName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  if (base.length < 2) base = "slack-user";
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    if (await db.handleAvailable(workspaceId, candidate)) return candidate;
  }
  // Astronomically unlikely; fall back to a random suffix.
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

// ============================ EGRESS (outbox ticker) ============================

const TICK_MS = Number(process.env.SLACK_OUTBOX_TICK_MS ?? 2000);
let ticking = false;
let tickCount = 0;

export function startSlackOutbox(): void {
  setInterval(() => {
    if (ticking) return; // re-entrancy guard (same as the scheduler)
    ticking = true;
    void tickOutbox()
      .catch((e) => console.error("slack outbox tick:", e))
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS).unref();
}

async function tickOutbox(): Promise<void> {
  // Housekeeping every ~100 ticks.
  if (tickCount++ % 100 === 0) await db.pruneSlackEvents(24).catch(() => {});

  // Claim + lease in one txn (FOR UPDATE SKIP LOCKED): the lease pushes next_attempt_at out so a
  // crash mid-send retries later rather than wedging the row.
  const jobs = await db.withTransaction(async (client) => {
    const rows = await db.claimDueOutbox(client, 50);
    if (rows.length) await db.leaseOutbox(client, rows.map((r) => r.outbox_id), 30);
    return rows;
  });
  if (!jobs.length) return;

  // Group by link and deliver each link's jobs strictly in order, stopping that link's batch on
  // the first non-delivery — guarantees a thread root is posted (and its message-link written)
  // before its replies, and respects Slack's per-channel rate limit.
  const byLink = new Map<string, db.OutboxJob[]>();
  for (const j of jobs) (byLink.get(j.link_id) ?? byLink.set(j.link_id, []).get(j.link_id)!).push(j);
  for (const group of byLink.values()) {
    for (const job of group) {
      const delivered = await deliverJob(job);
      if (!delivered) break;
    }
  }
}

async function deliverJob(job: db.OutboxJob): Promise<boolean> {
  // Map a Jungle thread reply back to the Slack thread (top-level if the root isn't mirrored).
  let threadTs: string | null = null;
  if (job.thread_root_id) {
    threadTs = (await db.getMessageLinkByJungleId(job.thread_root_id))?.slack_ts ?? null;
  }

  try {
    const { ts } = await slack.chatPostMessage(job.bot_token, {
      channel: job.slack_channel_id,
      text: jungleToSlackText(job.body),
      username: job.sender_display_name,
      iconUrl: job.sender_avatar_url,
      threadTs,
      replyBroadcast: job.also_to_channel,
      metadata: { event_type: "jungle_message", event_payload: { jungle_message_id: job.message_id } },
    });
    // Record the mapping + mark delivered atomically.
    await db.withTransaction(async (c) => {
      await db.insertMessageLink(
        {
          jungleMessageId: job.message_id,
          teamId: job.slack_team_id,
          slackChannelId: job.slack_channel_id,
          slackTs: ts,
          slackThreadTs: threadTs,
          origin: "jungle",
        },
        c,
      );
      await db.markOutboxDelivered(job.outbox_id, c);
    });
    return true;
  } catch (e) {
    return await handleDeliveryError(job, e);
  }
}

async function handleDeliveryError(job: db.OutboxJob, e: unknown): Promise<boolean> {
  if (e instanceof slack.SlackApiError) {
    if (e.code === "rate_limited") {
      // Backpressure the whole link; don't count it as an attempt.
      const until = new Date(Date.now() + (e.retryAfterSec ?? 1) * 1000 + 1000).toISOString();
      await db.deferLinkOutbox(job.link_id, until);
      return false;
    }
    if (slack.FATAL_SLACK_ERRORS.has(e.code)) {
      // parkLink flips the link to 'error' and, for auth-level codes, revokes the whole install.
      await db.markOutboxFailed(job.outbox_id, e.code);
      await parkLink(job.link_id, e.code);
      return false;
    }
  }
  // Transient: exponential backoff, give up after 10 attempts.
  const attempts = job.attempts + 1;
  const reason = e instanceof Error ? e.message : String(e);
  if (attempts >= 10) {
    await db.markOutboxFailed(job.outbox_id, reason);
    await parkLink(job.link_id, reason);
    return false;
  }
  const backoffSec = Math.min(2 ** attempts, 300);
  await db.bumpOutboxRetry(job.outbox_id, new Date(Date.now() + backoffSec * 1000).toISOString(), reason);
  return false;
}

// Move a link into the 'error' state and tell the UI.
async function parkLink(linkId: string, error: string): Promise<void> {
  const row = await db.setLinkError(linkId, error);
  if (row) {
    broadcastLink(row);
    // If the error was auth-level, revoke the whole install so ingress + every link stop.
    if (slack.AUTH_SLACK_ERRORS.has(error)) await db.setInstallStatus(row.workspace_id, "revoked");
  }
}

// ============================ LINK MANAGEMENT (called by routes) ============================

export async function getStatus(workspaceId: string): Promise<{ installed: boolean; teamName?: string | null; status?: "active" | "revoked" }> {
  const install = await db.getSlackInstallByWorkspace(workspaceId);
  if (!install) return { installed: false };
  return { installed: true, teamName: install.team_name, status: install.status };
}

export async function listSlackChannels(workspaceId: string): Promise<{ id: string; name: string; isPrivate: boolean; isMember: boolean }[]> {
  const install = await requireActiveInstall(workspaceId);
  const chans = await slack.conversationsList(install.bot_token);
  return chans
    .filter((c) => !c.is_archived)
    .map((c) => ({ id: c.id, name: c.name, isPrivate: !!c.is_private, isMember: !!c.is_member }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function linkChannel(
  me: db.Participant,
  channel: { id: string; workspace_id: string },
  slackChannelId: string,
): Promise<SlackChannelLink> {
  const install = await requireActiveInstall(me.workspace_id);
  if (await db.getLinkByJungleChannel(channel.id)) throw new ApiError(409, "this channel is already linked to Slack");

  // Join the Slack channel so the Events API delivers its messages (idempotent), then fetch its name.
  let name: string | null = null;
  try {
    await slack.conversationsJoin(install.bot_token, slackChannelId);
    const info = await slack.conversationsInfo(install.bot_token, slackChannelId);
    name = info.name;
  } catch (e) {
    const code = e instanceof slack.SlackApiError ? e.code : String(e);
    throw new ApiError(400, `couldn't join that Slack channel: ${code}`);
  }

  let row: db.SlackChannelLinkRow;
  try {
    row = await db.createChannelLink({
      workspaceId: me.workspace_id,
      jungleChannelId: channel.id,
      slackTeamId: install.team_id,
      slackChannelId,
      slackChannelName: name,
      createdBy: me.id,
    });
  } catch (e) {
    // Unique violation => that Slack channel is already mirrored to another Jungle channel.
    if ((e as { code?: string }).code === "23505") {
      throw new ApiError(409, "that Slack channel is already linked to another Jungle channel");
    }
    throw e;
  }
  broadcastLink(row);
  return toWireLink(row);
}

export async function unlinkChannel(channel: { id: string; workspace_id: string }): Promise<void> {
  await db.deleteChannelLink(channel.id);
  broadcastWorkspace(channel.workspace_id, { type: "slack_link_changed", channelId: channel.id, link: null });
}

export async function getChannelLink(jungleChannelId: string): Promise<SlackChannelLink | null> {
  const row = await db.getLinkByJungleChannel(jungleChannelId);
  return row ? toWireLink(row) : null;
}

async function requireActiveInstall(workspaceId: string): Promise<db.SlackInstall> {
  const install = await db.getSlackInstallByWorkspace(workspaceId);
  if (!install || install.status !== "active") throw new ApiError(400, "connect Slack in Settings first");
  return install;
}
