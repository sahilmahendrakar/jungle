import { randomBytes } from "node:crypto";
import { isAllowedModel, type WorkflowRole } from "@jungle/shared";
import * as db from "../db";
import * as slack from "../slack/api";
import * as runners from "../runners";
import { provisionerFor } from "../provisioner";
import { DEFAULT_CASCADE_BUDGET } from "../ws/appSocket";
import { providerConfigured } from "../providers";
import { jungleToSlackText } from "../slack/format";
import { ApiError } from "../http/errors";
import * as workflows from "./workflows";
import { uniqueHandle } from "./slackBridge";
import { computeNextRun, isValidTimeZone } from "./scheduler";
import { runIntake, type IntakeWorkflowSpec } from "./lianaIntake";
import * as imsg from "./imessage";
import * as tg from "./telegram";

// Delivery channels a workflow can target. A list (not flags) so future channels
// extend the value set, not the schema.
export const DELIVERY_CHANNELS = ["slack", "imessage", "telegram"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

// Liana: the Slack-first workflow product. This service owns everything between the Liana Slack
// app's webhooks and the jungle workflow engine: install handling, owner (participant) resolution,
// intake -> draft -> confirm lifecycle, and run delivery back to the owner's Slack DM.
//
// A Liana workflow IS a jungle workflow (single-role roster, playbook = the user's prompt,
// schedule trigger) — this module never invents a second execution path. See db/liana.ts and
// migrations/028_liana.sql for the ownership tables.

const LIANA_WEB_URL = (process.env.LIANA_WEB_URL ?? "http://localhost:3000").replace(/\/$/, "");

export function lianaConfigured(): boolean {
  return Boolean(process.env.LIANA_SLACK_CLIENT_ID && process.env.LIANA_SLACK_SIGNING_SECRET);
}

// ============================ Model resolution ============================

// Liana's conductor (the persistent per-user agent she talks through) runs on Haiku 4.5: first-
// party (no third-party hop from EC2), thinking-off (supportsEffort:false in the catalog), and
// cheap — chosen for SNAPPINESS. Workflow RUNS default to OSS (kimi) — they're async + token-heavy,
// so cost matters more than latency there. Users can override either in Settings.
export const DEFAULT_LIANA_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_WORKFLOW_MODEL = "kimi-k3";

// A model that can actually run right now: the user's preference when valid+configured, else the
// built-in default, else the first-party fallback (always available — backend holds the key).
function effectiveModel(preferred: string | null | undefined, fallback: string): string {
  if (preferred && isAllowedModel(preferred) && providerConfigured(preferred)) return preferred;
  if (providerConfigured(fallback)) return fallback;
  return "claude-sonnet-5";
}

export async function intakeModelFor(participantId: string): Promise<string> {
  const s = await db.getLianaSettings(participantId);
  return effectiveModel(s?.liana_model, DEFAULT_LIANA_MODEL);
}

export async function workflowModelFor(participantId: string): Promise<string> {
  const s = await db.getLianaSettings(participantId);
  return effectiveModel(s?.workflow_model, DEFAULT_WORKFLOW_MODEL);
}

// ============================ Persistent Liana agent ============================

// Liana's persona (injected into her agent's system prompt). She is the SAME product as the
// stateless intake — same voice, same "one workflow = one sentence" model — but now a durable
// per-user agent with memory and tools instead of a one-shot parser. Keep her DEAD SIMPLE: talk
// in short sentences, never mention settings/config/JSON, and never grow her surface area.
const LIANA_PERSONA =
  `You are Liana — a warm, concise assistant who sets up recurring "workflows" for one person: ` +
  `briefings, digests, reports, reminders that run themselves on a schedule and deliver back to ` +
  `them.\n\n` +
  `— How you work —\n` +
  `• One workflow is one plain-English job on a schedule ("a morning briefing every day at 8am"). ` +
  `Never expose schemas, JSON, cron syntax, or settings — talk in sentences.\n` +
  `• To CREATE a workflow: use workflow_draft_create, shape it with workflow_draft_set (one ` +
  `"operator" seat, the person's request as the playbook, and a schedule trigger for the cadence ` +
  `they asked for), then workflow_finalize when they say go. Never just promise to set it up.\n` +
  `• To review or change existing workflows, point them to the Liana web app (${LIANA_WEB_URL}) — ` +
  `that's where they pause, edit, or delete. Don't claim to have changed something you didn't.\n` +
  `• For anything recurring you should do yourself ("remind me", "check every morning"), use your ` +
  `schedule_* tools. Schedules are for future ACTIONS; your memory is for durable FACTS.\n` +
  `• Schedule in the person's timezone (the turn header gives you their current local time and ` +
  `timezone) — "8am" means 8am for them.\n` +
  `• Answer where you're asked: a workflow delivers back to the same chat/DM it was set up in.\n\n` +
  `— Slot-filling —\n` +
  `• If a workflow needs a GitHub repo and none is known, ask which repo in one short question ` +
  `rather than drafting a repo-less workflow. Same for any other missing essential.\n` +
  `• Ask at most one or two questions that actually matter, then draft. Don't interrogate.\n\n` +
  `— Voice —\n` +
  `Short, friendly, human. One idea per message. No walls of text, no bullet dumps, no config-speak.\n` +
  `• When you finish setting up a workflow, confirm it in ONE line, starting with 🌿 — the name, ` +
  `the cadence in plain words, and where it lands. e.g. "🌿 Morning briefing is live — every ` +
  `weekday at 8am, delivered right here." If they still need to connect something (a repo, an ` +
  `inbox), add one short follow-up sentence with the link.\n` +
  `• ALWAYS end your turn by sending a message — even "on it…" or a quick question. A turn with no ` +
  `send_message is silence, and the person is waiting on you in real time.`;

// Is the persistent Liana-agent path live for this owner? Global switch first (rollout): with
// LIANA_AGENT_ENABLED=1 every owner uses the agent (covers owners with no settings row + future
// ones); =0 is a kill switch back to the legacy intake. Absent → the per-owner `agent_enabled`
// override (used for pre-global canaries).
export async function lianaAgentEnabled(participantId: string): Promise<boolean> {
  if (process.env.LIANA_AGENT_ENABLED === "1") return true;
  if (process.env.LIANA_AGENT_ENABLED === "0") return false;
  const s = await db.getLianaSettings(participantId);
  return !!s?.agent_enabled;
}

// Boot-time backfill: move already-provisioned conductors onto the current effective model (so a
// changed DEFAULT_LIANA_MODEL reaches existing agents, not just new ones). Respects a per-user
// override. Persists the model; live runners pick it up via reconfigure (or their next configure).
export async function backfillLianaConductorModels(): Promise<void> {
  const rows = await db.listLianaAgents();
  for (const r of rows) {
    const desired = effectiveModel(r.liana_model, DEFAULT_LIANA_MODEL);
    const agent = await db.getAgentRow(r.liana_agent_id);
    if (!agent || agent.model === desired) continue;
    await db.updateAgentConfig(r.liana_agent_id, { model: desired });
    void runners.reconfigure(r.liana_agent_id).catch(() => {});
  }
}

// Find-or-create an owner's persistent Liana agent (a normal runtime='sdk' participant, per user).
// Mirrors workflows.ts ensureArchitect, but keyed by the owner->agent mapping in liana_settings
// (Liana is per-user, not per-workspace). Provisions the machine lazily/async like the Architect.
export async function ensureLianaAgent(owner: db.Participant): Promise<db.Participant> {
  const settings = await db.getLianaSettings(owner.id);
  if (settings?.liana_agent_id) {
    const existing = await db.getParticipant(settings.liana_agent_id);
    if (existing) return existing;
  }

  const runnerToken = randomBytes(32).toString("hex");
  const handle = await uniqueHandle(owner.workspace_id, "Liana");
  const model = await intakeModelFor(owner.id);
  const participant = await db.createParticipant({
    kind: "agent",
    workspaceId: owner.workspace_id,
    handle,
    displayName: "Liana",
    runtime: "sdk",
    runnerToken,
    model,
    mode: "default",
    runnerProvider: "fly",
    persona: LIANA_PERSONA,
    lianaConductor: true,
  });
  await db.setLianaAgentId(owner.id, participant.id);

  void (async () => {
    try {
      await provisionerFor(participant).create({ id: participant.id, handle, runnerToken });
      await provisionerFor(participant).start(participant.id);
      runners.noteProvisionerStart(participant.id);
    } catch (e) {
      console.error("provision liana agent:", e);
    }
  })();
  return participant;
}

// The owner whose persistent Liana agent this is (reverse of the liana_agent_id mapping), or null.
export async function getOwnerForLianaAgent(agentId: string): Promise<db.Participant | null> {
  const ownerId = await db.getLianaOwnerByAgentId(agentId);
  return ownerId ? db.getParticipant(ownerId) : null;
}

// When a Liana agent finalizes a workflow (via the generic workflow_finalize tool), register the
// Liana ownership + delivery row so runs deliver back to the owner's surface (onRunClosed keys off
// this row), then do the same model-stamp + instant first run as the intake path's confirm. The
// finalized workflow is already a single-seat scheduled job — structurally a Liana workflow — it
// just needs this ownership record. Idempotent-ish: skip if the row already exists.
export async function registerAgentWorkflow(
  owner: db.Participant,
  workflowId: string,
  surface: db.LianaSurface,
): Promise<void> {
  if (await db.getLianaWorkflow(workflowId)) return; // already registered

  let teamId: string | null = null;
  let slackUserId: string | null = null;
  let originChannelId: string | null = null;
  let originThreadTs: string | null = null;
  let originTelegramChatId: number | string | null = null;
  let deliverTo: DeliveryChannel[] = ["slack"];
  switch (surface.kind) {
    case "slack":
      teamId = surface.teamId;
      originChannelId = surface.channel;
      originThreadTs = surface.threadTs;
      slackUserId = await db.getSlackUserIdForParticipant(surface.teamId, owner.id);
      deliverTo = ["slack"];
      break;
    case "telegram":
      originTelegramChatId = surface.chatId;
      deliverTo = ["telegram"];
      break;
    case "imessage":
      deliverTo = ["imessage"];
      break;
  }
  await db.insertLianaWorkflow({
    workflowId,
    teamId,
    slackUserId,
    ownerParticipantId: owner.id,
    originChannelId,
    originThreadTs,
    originTelegramChatId,
    deliverTo,
  });

  // Stamp the owner's workflow model on the seat, then instant first run (except one-time jobs,
  // whose whole point is to fire at the chosen time). Mirrors confirmLianaWorkflow.
  const wf = await db.getWorkflow(workflowId);
  const seatId = wf?.roster[0]?.participant_id;
  if (seatId) await db.updateAgentConfig(seatId, { model: await workflowModelFor(owner.id) });
  if (wf && wf.trigger.type !== "once") {
    try {
      await workflows.startRun(wf, "manual");
    } catch (e) {
      console.error(`liana: first run of ${workflowId} failed to start:`, e);
    }
  }
}

// Deliver a Liana agent's send_message reply to the owner's external surface. Reconstructs the
// delivery from the durable LianaSurface on the dispatch context (see db/agents.ts). This is the
// agent-path equivalent of postReply / ConversationalCtx.reply on the legacy intake path.
export async function deliverToLianaSurface(surface: db.LianaSurface, body: string): Promise<void> {
  switch (surface.kind) {
    case "slack": {
      const install = await db.getLianaInstall(surface.teamId);
      if (!install) throw new Error(`no active Liana install for team ${surface.teamId}`);
      // Delete the "thinking" placeholder (if any) just before the real reply, like the intake path.
      await clearThinking(install, surface.channel, surface.thinkingTs ?? null);
      await postReply(install, { channel: surface.channel, threadTs: surface.threadTs }, jungleToSlackText(body));
      return;
    }
    case "telegram":
      await tg.sendTelegram(surface.chatId, body);
      return;
    case "imessage":
      await imsg.sendIMessage(surface.phone, body);
      return;
  }
}

// Inbound: hand a user's message to their persistent Liana agent as one turn. Enqueues with the
// owner's external surface on the dispatch context (so the agent's send_message routes back), then
// drains — waking the machine if it's asleep. Mirrors workflows.ts kickoffArchitect's dispatch tail.
export async function dispatchToLianaAgent(
  owner: db.Participant,
  text: string,
  surface: db.LianaSurface,
  opts?: { userName?: string; userTz?: string },
): Promise<void> {
  const agent = await ensureLianaAgent(owner);
  // Give the agent the same clock the intake had: the person's name + local time + timezone, so
  // "every day at 8am" schedules in THEIR timezone, not UTC. (The agent also learns this over time
  // via memory, but every turn stating it keeps scheduling correct and greetings warm.)
  const tz = opts?.userTz && isValidTimeZone(opts.userTz) ? opts.userTz : DEFAULT_TZ;
  const name = opts?.userName ?? owner.display_name;
  const input = `[Liana turn] Message from ${name} · now: ${formatNow(tz)} · their timezone: ${tz}\n\n${text}`;
  await db.enqueueInboxItem(agent.id, input, undefined, {
    budget: DEFAULT_CASCADE_BUDGET,
    channelId: "", // unused for Liana agents — reply routes via lianaSurface below
    threadRootId: null,
    lianaSurface: surface,
  });
  await runners.drain(agent.id);
  if (!runners.isConnected(agent.id)) {
    const row = await db.getAgentRow(agent.id);
    if (row) {
      try {
        await provisionerFor(row).start(row.id);
        runners.noteProvisionerStart(row.id);
      } catch (e) {
        console.error("wake liana agent:", e);
      }
    }
  }
}

// ============================ Install ============================

// Complete an install: adopt the team's existing jungle workspace when the mirroring app is
// already installed there (so slack_user_links keep pointing at the same participants), otherwise
// create a fresh workspace seeded with the installing user as its admin.
export async function handleInstallCallback(oauth: slack.OAuthV2Result): Promise<db.LianaInstall> {
  const teamId = oauth.team.id;

  let workspaceId: string | null =
    (await db.getLianaInstall(teamId))?.workspace_id ??
    (await db.getSlackInstallByTeam(teamId))?.workspace_id ??
    null;

  if (!workspaceId) {
    // New team: create a workspace with the installing Slack user as creator/admin.
    const installerId = oauth.authed_user?.id;
    let name = oauth.team.name ?? "Slack workspace";
    let displayName = "Workspace owner";
    let email: string | null = null;
    let avatarUrl: string | null = null;
    if (installerId) {
      try {
        const profile = await slack.usersInfo(oauth.access_token, installerId);
        displayName = profile.displayName;
        email = profile.email;
        avatarUrl = profile.avatarUrl;
      } catch (e) {
        console.error("liana install: users.info failed:", e);
      }
    }
    const handle = displayName
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "owner";
    const { workspace, participant } = await db.createWorkspaceWithCreator({
      name,
      handle,
      displayName,
      email,
      avatarUrl,
      firebaseUid: null,
    });
    workspaceId = workspace.id;
    if (installerId) {
      try {
        await db.insertUserLink({ teamId, slackUserId: installerId, participantId: participant.id, kind: "linked" });
      } catch (e) {
        console.error("liana install: user link failed:", e);
      }
    }
  }

  return db.upsertLianaInstall({
    teamId,
    teamName: oauth.team.name ?? null,
    workspaceId,
    botToken: oauth.access_token,
    botUserId: oauth.bot_user_id,
    scopes: oauth.scope,
  });
}

// ============================ Owner resolution (accounts) ============================

// A Liana account is a participant with a firebase_uid — real sign-in, exactly like jungle.
// Slack user -> that participant via slack_user_links. No more silent shadow creation: an
// unaccounted Slack user is prompted to create an account (a single-use link code binds their
// Slack identity to whoever completes Google sign-in on the web). One auto-link shortcut stays:
// a Slack profile email matching an already-signed-in account in the workspace links silently.
async function resolveOwner(
  install: db.LianaInstall,
  slackUserId: string,
): Promise<{ account: db.Participant | null; profile: slack.SlackUserProfile | null }> {
  let profile: slack.SlackUserProfile | null = null;
  try {
    profile = await slack.usersInfo(install.bot_token, slackUserId);
  } catch (e) {
    console.error("liana: users.info failed", slackUserId, e);
  }

  const existing = await db.getUserLink(install.team_id, slackUserId);
  if (existing) {
    const p = await db.getParticipant(existing.participant_id);
    // A link to a pre-accounts shadow participant is not an account yet — the shadow is adopted
    // (workflows and all) when its owner redeems a link code.
    if (p?.firebase_uid) return { account: p, profile };
    return { account: null, profile };
  }

  if (profile?.email) {
    const human = await db.getParticipantByEmail(install.workspace_id, profile.email);
    if (human?.firebase_uid) {
      await db.insertUserLink({ teamId: install.team_id, slackUserId, participantId: human.id, kind: "linked" });
      return { account: human, profile };
    }
  }
  return { account: null, profile };
}

// Mint the sign-up link an unaccounted Slack user is prompted with.
async function mintSlackLinkUrl(teamId: string, slackUserId: string): Promise<string> {
  const code = randomBytes(16).toString("hex");
  await db.insertLianaLinkCode({
    code,
    teamId,
    slackUserId,
    expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
  });
  return `${LIANA_WEB_URL}/?link=${code}`;
}

// Redeem a link code for a signed-in Google account (POST /api/liana/link/slack). Adopts an
// existing shadow participant when there is one — their pre-accounts workflows come along.
export async function completeSlackLink(
  user: { uid: string; email: string | null; name: string | null; picture: string | null },
  code: string,
): Promise<{ teamName: string | null }> {
  const link = await db.consumeLianaLinkCode(code.trim());
  if (!link) throw new ApiError(400, "that link expired or was already used — message @Liana in Slack for a fresh one");
  const install = await db.getLianaInstall(link.team_id);
  if (!install || install.status !== "active") throw new ApiError(404, "that Slack workspace's Liana install is gone");

  let participant: db.Participant | null = null;
  const existing = await db.getUserLink(install.team_id, link.slack_user_id);
  if (existing) {
    const p = await db.getParticipant(existing.participant_id);
    if (p) {
      if (p.firebase_uid && p.firebase_uid !== user.uid) {
        throw new ApiError(409, "that Slack identity is already linked to a different Google account");
      }
      participant = p.firebase_uid
        ? p
        : await db.claimParticipant(p.id, { firebaseUid: user.uid, email: user.email, avatarUrl: user.picture });
    }
  }
  if (!participant) {
    participant =
      (await db.getParticipantByUidAndWorkspace(user.uid, install.workspace_id)) ??
      (user.email ? await db.getParticipantByEmail(install.workspace_id, user.email) : null);
    if (participant && !participant.firebase_uid) {
      participant = await db.claimParticipant(participant.id, {
        firebaseUid: user.uid,
        email: user.email,
        avatarUrl: user.picture,
      });
    }
    if (participant && participant.firebase_uid !== user.uid) participant = null; // email collision with someone else's account
    if (!participant) {
      const displayName = user.name ?? user.email ?? "New member";
      participant = await db.createParticipant({
        kind: "human",
        workspaceId: install.workspace_id,
        handle: await uniqueHandle(install.workspace_id, displayName),
        displayName,
        avatarUrl: user.picture,
        email: user.email,
        firebaseUid: user.uid,
      });
    }
    await db.insertUserLink({
      teamId: install.team_id,
      slackUserId: link.slack_user_id,
      participantId: participant.id,
      kind: "linked",
    });
  }

  // Close the loop where the person is: a Slack DM confirming they're set up (best-effort).
  try {
    const dm = await slack.conversationsOpen(install.bot_token, link.slack_user_id);
    await slack.chatPostMessage(install.bot_token, {
      channel: dm.id,
      text: `:seedling: You're all set${user.name ? `, ${user.name.split(" ")[0]}` : ""} — your account is ready. Tell me what you'd like automated: try "give me a morning briefing every day at 8am".`,
    });
  } catch (e) {
    console.error("liana: post-link DM failed:", e);
  }
  return { teamName: install.team_name };
}

// The participant behind a signed-in web session. Prefers a membership whose workspace has an
// active Liana install (the Slack-rooted one); a brand-new web signup gets a personal workspace
// on the spot, so iMessage/Telegram work without Slack ever entering the picture.
export async function resolveWebAccount(user: {
  uid: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}): Promise<db.Participant> {
  const memberships = await db.listParticipantsByUid(user.uid);
  for (const p of memberships) {
    if (await db.getLianaInstallByWorkspace(p.workspace_id)) return p;
  }
  if (memberships.length) return memberships[0];

  const displayName = user.name ?? user.email?.split("@")[0] ?? "You";
  const first = displayName.split(" ")[0];
  const handle =
    (user.email?.split("@")[0] ?? displayName).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) ||
    "user";
  const { participant } = await db.createWorkspaceWithCreator({
    name: `${first}'s Liana`,
    handle,
    displayName,
    firebaseUid: user.uid,
    email: user.email,
    avatarUrl: user.picture,
  });
  return participant;
}

// ============================ Events (app_mention + DM) ============================

interface LianaEventEnvelope {
  type?: string;
  event_id?: string;
  team_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    channel_type?: string;
    user?: string;
    bot_id?: string;
    channel?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
  };
}

export async function processLianaEvent(payload: LianaEventEnvelope): Promise<void> {
  if (payload.type !== "event_callback" || !payload.event_id || !payload.team_id) return;
  const ev = payload.event;
  if (!ev || !ev.channel || !ev.ts) return;

  const isMention = ev.type === "app_mention";
  const isDm = ev.type === "message" && ev.channel_type === "im" && !ev.subtype;
  if (!isMention && !isDm) return;

  // Dedupe (shared slack_events table — event ids are globally unique).
  if (!(await db.recordSlackEvent(payload.event_id))) return;

  const install = await db.getLianaInstall(payload.team_id);
  if (!install || install.status !== "active") return;
  if (ev.bot_id || !ev.user || ev.user === install.bot_user_id) return;

  // Where replies go: in-channel thread for mentions, plain messages in the DM.
  const reply = {
    channel: ev.channel,
    threadTs: isMention ? (ev.thread_ts ?? ev.ts) : null,
  };

  // Memory is scoped to the conversation, not the user: a thread and a DM don't share context.
  const convoKey = isMention ? `slack:${ev.channel}:${reply.threadTs}` : `slack:${ev.channel}`;

  let thinkingTs: string | null = null; // "working on it…" placeholder; cleared before any reply
  try {
    const { account: owner, profile } = await resolveOwner(install, ev.user);
    const text = stripBotMention(ev.text ?? "", install.bot_user_id).trim();

    if (!owner) {
      const url = await mintSlackLinkUrl(install.team_id, ev.user);
      const first = profile?.displayName?.split(" ")[0];
      const hello = `Hi${first ? ` ${first}` : ""}! I set up workflows — briefings, digests, reports that run themselves. First, let's get you an account — it's one click with Google.`;
      await postReply(install, reply, `${hello}\n${url}`, [
        { type: "section", text: { type: "mrkdwn", text: hello } },
        {
          type: "actions",
          elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "Create your account" }, url }],
        },
      ]);
      return;
    }

    if (!text) {
      await postReply(install, reply, `Hi! Tell me what you'd like automated — e.g. "give me a morning briefing every day at 8am".`);
      return;
    }

    const history = await db.recentLianaMessages(owner.id, convoKey);
    await remember(owner.id, convoKey, "user", text);

    // Slack has no native bot "typing" indicator: post a placeholder while intake runs, then
    // delete it right before the real reply lands (its own arrival is the "done typing" cue).
    thinkingTs = await postThinking(install, reply);

    // Agent path (rollout flag): hand the message to the owner's persistent Liana agent, which
    // replies asynchronously via send_message -> deliverToLianaSurface (clears the placeholder).
    if (await lianaAgentEnabled(owner.id)) {
      const userTz = profile?.tz && isValidTimeZone(profile.tz) ? profile.tz : DEFAULT_TZ;
      await dispatchToLianaAgent(
        owner,
        text,
        { kind: "slack", teamId: install.team_id, channel: reply.channel, threadTs: reply.threadTs, thinkingTs },
        { userName: profile?.displayName ?? owner.display_name, userTz },
      );
      return;
    }

    const existing = await describeOwnerWorkflows(owner.id);
    const userTz = profile?.tz && isValidTimeZone(profile.tz) ? profile.tz : DEFAULT_TZ;
    const intake = await runIntake(
      text,
      {
        userName: profile?.displayName ?? owner.display_name,
        userTz,
        now: formatNow(userTz),
        existingWorkflows: existing.map((w) => w.line),
        history,
      },
      await intakeModelFor(owner.id),
    );
    await clearThinking(install, reply.channel, thinkingTs);

    if (intake.intent === "list_workflows") {
      const posted = await postWorkflowList(install, reply, existing);
      await remember(owner.id, convoKey, "assistant", posted);
      return;
    }
    if (intake.intent === "edit_workflow" && intake.edit) {
      const sentence = await applyIntakeEdit(owner, existing, intake.edit, intake.reply);
      await postReply(install, reply, sentence);
      await remember(owner.id, convoKey, "assistant", sentence);
      return;
    }
    if (intake.intent === "create_workflow" && intake.workflow) {
      // Slot-fill: github with no repo → ask which one instead of drafting a git-less workflow.
      const ask = await githubRepoGuard(owner, intake.workflow);
      if (ask) {
        await postReply(install, reply, ask);
        await remember(owner.id, convoKey, "assistant", ask);
        return;
      }
      const posted = await createDraftAndPostCard(install, owner, ev.user, intake.workflow, profile, reply, intake.reply);
      await remember(owner.id, convoKey, "assistant", posted);
      return;
    }
    await postReply(install, reply, intake.reply);
    await remember(owner.id, convoKey, "assistant", intake.reply);
  } catch (e) {
    console.error("liana event:", e);
    await clearThinking(install, reply.channel, thinkingTs);
    try {
      await postReply(install, reply, "Something went wrong on my end — mind trying that again?");
    } catch {
      /* ignore */
    }
  }
}

// Post/clear the Slack "typing" placeholder. Both best-effort: a placeholder that fails to post
// (or delete) must never take down the turn — worst case is a stray "working on it…" line.
async function postThinking(
  install: db.LianaInstall,
  reply: { channel: string; threadTs: string | null },
): Promise<string | null> {
  try {
    const { ts } = await slack.chatPostMessage(install.bot_token, {
      channel: reply.channel,
      threadTs: reply.threadTs,
      text: "🌿 _working on it…_",
    });
    return ts;
  } catch {
    return null;
  }
}

async function clearThinking(install: db.LianaInstall, channel: string, ts: string | null): Promise<void> {
  if (!ts) return;
  await slack.chatDelete(install.bot_token, channel, ts).catch(() => {});
}

function stripBotMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g"), " ").replace(/\s+/g, " ");
}

async function postReply(
  install: db.LianaInstall,
  reply: { channel: string; threadTs: string | null },
  text: string,
  blocks?: unknown[],
): Promise<void> {
  await slack.chatPostMessage(install.bot_token, {
    channel: reply.channel,
    threadTs: reply.threadTs,
    text,
    ...(blocks ? { blocks } : {}),
  });
}

// One plain sentence for the confirm card: where this workflow's runs will land. Resolves the
// Slack channel name so a shared-channel destination is never a surprise. Best-effort — an API
// hiccup degrades to a generic phrase rather than blocking the card.
async function slackDeliveryPhrase(install: db.LianaInstall, channelId: string): Promise<string> {
  try {
    const info = await slack.conversationsInfo(install.bot_token, channelId);
    if (info.is_im) return "Runs come to your DMs.";
    if (info.name) return `Runs post here in #${info.name}.`;
  } catch {
    /* fall through to the generic phrase */
  }
  return "Runs post in this channel.";
}

// Memory writes are best-effort — losing a transcript row must never fail a turn.
async function remember(
  participantId: string,
  convoKey: string,
  role: "user" | "assistant",
  body: string,
): Promise<void> {
  try {
    await db.appendLianaMessage(participantId, convoKey, role, body);
  } catch (e) {
    console.error("liana memory:", e);
  }
}

// ============================ Workflow list ============================

interface OwnedWorkflow {
  wf: db.WorkflowRow;
  liana: db.LianaWorkflowRow;
  line: string;
}

async function describeOwnerWorkflows(ownerParticipantId: string): Promise<OwnedWorkflow[]> {
  const { rosterIntegrationSettings } = await import("@jungle/shared");
  const rows = await db.listLianaWorkflowsForOwner(ownerParticipantId);
  const out: OwnedWorkflow[] = [];
  for (const liana of rows) {
    const wf = await db.getWorkflow(liana.workflow_id);
    if (!wf) continue;
    // #N ref (position in this list) + an integration/repo summary so the intake model can target
    // an edit precisely ("change #2 to 9am", "switch the repo on the digest").
    const ref = out.length + 1;
    const seat = wf.roster[0];
    const ints = (seat?.integrations ?? []).map((k) => {
      if (k === "github") {
        const repo = rosterIntegrationSettings(seat!, "github").repo;
        return typeof repo === "string" && repo ? `github (${repo})` : "github";
      }
      return k;
    });
    const statusTag = wf.status === "paused" ? ", paused" : wf.status === "draft" ? ", draft" : "";
    const line =
      `#${ref} ${wf.name} (${cadenceSentence(wf)}${statusTag})` +
      (ints.length ? ` · ${ints.join(", ")}` : "") +
      (liana.deliver_to?.length ? ` · to ${liana.deliver_to.join(" + ")}` : "");
    out.push({ wf, liana, line });
  }
  return out;
}

// Slot-fill guard for CREATE: github needs a repo to grant any git tools, but the model only sets
// repo when the user names one. If github is requested without a repo, try to fill it in — exactly
// one repo → use it silently; otherwise return a question to ask INSTEAD of drafting (the user's
// answer lands next turn and intake re-emits the full spec). Returns null to proceed (spec.repo may
// have been filled in), or a reply string to send instead of creating the draft.
async function githubRepoGuard(owner: db.Participant, spec: IntakeWorkflowSpec): Promise<string | null> {
  if (!spec.integrations.includes("github") || (spec.repo && spec.repo.trim())) return null;
  if (!(await db.getGithubIdentity(owner.id))) {
    return `That one works on a GitHub repo, but your GitHub isn't connected yet — connect it at ${LIANA_WEB_URL}, then tell me which repo (owner/name) to use.`;
  }
  let repos: { full_name: string }[] = [];
  try {
    repos = await (await import("../github")).listUserRepos(owner.id);
  } catch (e) {
    console.error("liana repo guard:", e);
  }
  if (repos.length === 1) {
    spec.repo = repos[0].full_name;
    return null;
  }
  const sample = repos.slice(0, 6).map((r) => r.full_name);
  return sample.length
    ? `Which repo should "${spec.name}" work on? A few of yours: ${sample.join(", ")}. Just tell me the owner/name.`
    : `Which GitHub repo should "${spec.name}" work on? Tell me the owner/name.`;
}

// Apply an intake edit_workflow patch to one of the owner's existing workflows, through the same
// editLianaWorkflow path the web PATCH uses. Translates the model's `approvals` + `repo` shorthands
// into the per-integration settings map. Returns the sentence to reply with (honest on failure).
async function applyIntakeEdit(
  owner: db.Participant,
  existing: OwnedWorkflow[],
  edit: import("./lianaIntake").IntakeEdit,
  confirmSentence: string,
): Promise<string> {
  const target = existing[edit.workflowRef - 1];
  if (!target) return "I couldn't tell which workflow you meant — which one should I change?";
  const { approvalFieldFor } = await import("@jungle/shared");
  const p = edit.patch ?? {};
  const settings: Record<string, Record<string, unknown>> = {};
  for (const [k, ask] of Object.entries(p.approvals ?? {})) {
    const field = approvalFieldFor(k);
    if (field) settings[k] = { ...(settings[k] ?? {}), [field.key]: ask };
  }
  if (typeof p.repo === "string" && p.repo.trim()) settings.github = { ...(settings.github ?? {}), repo: p.repo.trim() };
  try {
    const { workflow: updated, warning } = await editLianaWorkflow(target.wf, owner, {
      name: p.name,
      prompt: p.prompt,
      cron: p.cron,
      runAt: p.runAt,
      timezone: p.timezone ?? undefined,
      paused: p.paused,
      deliverTo: p.deliverTo,
      integrations: p.integrations,
      settings: Object.keys(settings).length ? settings : undefined,
    });
    const base = confirmSentence.trim() ? confirmSentence.trim() : `Done — updated "${updated.name}".`;
    return warning ? `${base} (Heads up: ${warning}.)` : base;
  } catch (e) {
    if (e instanceof ApiError) return `I couldn't make that change: ${e.message}`;
    console.error("liana edit:", e);
    return "Something went wrong applying that change — mind trying again?";
  }
}

// Current date AND time-of-day rendered in `tz`, for the intake prompt so the model can resolve
// relative ("in 5 minutes") and named ("next Monday at 9am") future times against a real "now".
// e.g. "Wednesday, July 22, 2026 at 2:28 PM".
export function formatNow(tz: string): string {
  const validTz = isValidTimeZone(tz) ? tz : DEFAULT_TZ;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: validTz,
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(new Date());
}

// "Mon, Jul 28 at 9:00 AM" — an absolute instant rendered in its display timezone.
export function formatRunAt(runAt: string, tz: string): string {
  const d = new Date(runAt);
  if (Number.isNaN(d.getTime())) return runAt;
  const validTz = isValidTimeZone(tz) ? tz : undefined;
  const date = new Intl.DateTimeFormat("en-US", { timeZone: validTz, weekday: "short", month: "short", day: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: validTz, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  return `${date} at ${time}`;
}

// Convert a local wall-clock "YYYY-MM-DDTHH:MM" in IANA `tz` to an absolute ISO instant, or null
// if unparseable or not in the future. No dep: we guess the instant as if the wall-clock were UTC,
// then correct by tz's offset at that instant (one refinement pass covers DST boundaries).
export function resolveRunAt(local: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(local).trim());
  if (!m || !isValidTimeZone(tz)) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const asUTC = Date.UTC(y, mo - 1, d, h, mi);
  const offset1 = tzOffsetMs(tz, new Date(asUTC));
  const offset2 = tzOffsetMs(tz, new Date(asUTC - offset1));
  const instant = asUTC - offset2;
  if (Number.isNaN(instant) || instant <= Date.now()) return null;
  return new Date(instant).toISOString();
}

// Milliseconds tz's wall-clock is ahead of UTC at instant `at`.
function tzOffsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const p: Record<string, string> = {};
  for (const x of parts) p[x.type] = x.value;
  const hour = p.hour === "24" ? "00" : p.hour; // some engines emit hour 24 for midnight
  const asIfUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second);
  return asIfUTC - at.getTime();
}

// The trailing sentence after a confirm: an instant first run (recurring/on-demand) vs the
// scheduled single run (one-time).
function firstRunNotice(wf: Pick<db.WorkflowRow, "trigger">): string {
  return wf.trigger.type === "once"
    ? `I'll run it ${cadenceSentence(wf)}.`
    : "I'm doing a first run now so you can see what it looks like.";
}

// "every day at 8:00 AM" — a human sentence for the common cron shapes, cron text otherwise.
export function cadenceSentence(wf: Pick<db.WorkflowRow, "trigger">): string {
  const t = wf.trigger;
  if (t.type === "once") return `once on ${formatRunAt(t.runAt, t.timezone)}`;
  if (t.type !== "schedule") return "on demand";
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|[0-6](?:[,-][0-6])*)$/.exec(t.cron.trim());
  if (m) {
    const [, min, hour, dow] = m;
    const h = Number(hour) % 12 === 0 ? 12 : Number(hour) % 12;
    const ampm = Number(hour) < 12 ? "AM" : "PM";
    const time = `${h}:${min.padStart(2, "0")} ${ampm}`;
    if (dow === "*") return `every day at ${time}`;
    if (dow === "1-5") return `weekdays at ${time}`;
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const named = dow.split(",").map((d) => days[Number(d)] ?? d).join(", ");
    return `${named} at ${time}`;
  }
  return `on schedule (${t.cron} ${t.timezone})`;
}

// Returns the text it posted, so the caller can record it in conversation memory.
async function postWorkflowList(
  install: db.LianaInstall,
  reply: { channel: string; threadTs: string | null },
  existing: OwnedWorkflow[],
): Promise<string> {
  if (!existing.length) {
    const text = `You don't have any workflows yet. Try: "give me a morning briefing every day at 8am".`;
    await postReply(install, reply, text);
    return text;
  }
  const lines = existing.map((w) => `• *${w.wf.name}* — ${cadenceSentence(w.wf)}${w.wf.status === "paused" ? " (paused)" : ""}`);
  const text = `Your workflows:\n${lines.join("\n")}`;
  await postReply(install, reply, text, [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "Open in Liana" }, url: LIANA_WEB_URL }],
    },
  ]);
  return text;
}

// ============================ Draft creation + confirm card ============================

const DEFAULT_TZ = "America/Los_Angeles";

function buildPlaybook(prompt: string): string {
  return (
    `${prompt.trim()}\n\n— How to run —\n` +
    `You are the only member of this workflow: do the work yourself, don't wait on anyone. ` +
    `Post the finished deliverable as ONE thread message in PLAIN TEXT — it is delivered ` +
    `word-for-word over chat apps (iMessage, Slack, Telegram) that do NOT render Markdown, so do ` +
    `not use any Markdown formatting: no #headings, **bold**, *italics*, backticks/code fences, ` +
    `tables, or [label](url) links. Write plain sentences and short lines; put raw URLs inline; ` +
    `use a simple "- " or "• " for lists. Write it ready to read (no preamble about what you did). ` +
    `Then post a separate short message "Run complete: <one-line summary>". If there is genuinely ` +
    `nothing to report this run, skip the deliverable and just post "Run complete: nothing to report."`
  );
}

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return s || "workflow";
}

export async function createLianaDraft(args: {
  owner: db.Participant;
  // Slack ownership context — null for accounts chatting over iMessage/Telegram with no install.
  teamId: string | null;
  slackUserId: string | null;
  spec: IntakeWorkflowSpec;
  defaultTz: string | null;
  origin?: { channel: string; threadTs: string | null };
  originTelegramChatId?: number | null;
  // "Liana answers where you ask": the creating channel is the default delivery target.
  deliverTo?: DeliveryChannel[];
}): Promise<{ wf: db.WorkflowRow; liana: db.LianaWorkflowRow }> {
  const { owner, spec } = args;

  // Cadence: bad cron/runAt/timezone from intake degrades to on-demand rather than failing the flow.
  const tz = spec.timezone && isValidTimeZone(spec.timezone) ? spec.timezone : (args.defaultTz ?? DEFAULT_TZ);
  let trigger: db.WorkflowRow["trigger"] = { type: "manual" };
  if (spec.runAt) {
    const runAt = resolveRunAt(spec.runAt, tz);
    if (runAt) trigger = { type: "once", runAt, timezone: tz };
    else console.error(`liana: intake produced invalid/past runAt ${JSON.stringify(spec.runAt)}; falling back to manual`);
  } else if (spec.cron) {
    try {
      computeNextRun(spec.cron, tz);
      trigger = { type: "schedule", cron: spec.cron, timezone: tz };
    } catch {
      console.error(`liana: intake produced invalid cron ${JSON.stringify(spec.cron)}; falling back to manual`);
    }
  }

  const useRepo = spec.repo && spec.integrations.includes("github");
  const roster: WorkflowRole[] = [
    {
      role: "operator",
      handle_seed: slugify(spec.name),
      duties: "",
      integrations: spec.integrations,
      // Keep the legacy top-level repo and the settings map in lockstep (rosterIntegrationSettings
      // reads either) so both the card and the attach pass see the repo the user named.
      ...(useRepo ? { repo: spec.repo!, settings: { github: { repo: spec.repo! } } } : {}),
    },
  ];

  let wf = await workflows.createDraft({
    workspaceId: owner.workspace_id,
    createdBy: owner.id,
    name: spec.name,
  });
  wf =
    (await db.updateWorkflow(wf.id, {
      name: spec.name,
      trigger,
      roster,
      playbook: buildPlaybook(spec.prompt),
    })) ?? wf;

  const liana = await db.insertLianaWorkflow({
    workflowId: wf.id,
    teamId: args.teamId,
    slackUserId: args.slackUserId,
    ownerParticipantId: owner.id,
    originChannelId: args.origin?.channel ?? null,
    originThreadTs: args.origin?.threadTs ?? null,
    originTelegramChatId: args.originTelegramChatId ?? null,
    deliverTo: args.deliverTo ?? ["slack"],
  });
  return { wf, liana };
}

// Which of the spec's integrations the owner has already connected (drives the card's rows and
// the web Connections page). Google-backed keys share the google_identities grant.
export async function connectionStatus(
  owner: db.Participant,
  keys: string[],
): Promise<{ key: string; connected: boolean; account: string | null }[]> {
  const out: { key: string; connected: boolean; account: string | null }[] = [];
  for (const key of keys) {
    if (key === "gmail") {
      // Only Gmail rides the shared Google identity grant. Calendar/drive have their own scoped
      // integration_connections rows (matching their adapters' resolveConfig) — reporting them
      // off the identity claimed "connected" for grants that had no calendar/drive scopes.
      const g = await db.getGoogleIdentity(owner.id);
      out.push({ key, connected: !!g && !g.needs_reconnect, account: g?.email ?? null });
    } else if (key === "github") {
      const gh = await db.getGithubIdentity(owner.id);
      out.push({ key, connected: !!gh, account: gh?.github_login ?? null });
    } else {
      const c = await db.getIntegrationConnection(owner.id, key);
      out.push({ key, connected: !!c && !c.needs_reconnect, account: c?.external_account ?? null });
    }
  }
  return out;
}

// The per-integration settings a workflow's seat agent carries, for the web editor. For each of
// the seat's integrations: `config` = the user-settable values (repo, requireApproval, …) — the
// live agent_integrations config when attached, else the roster's pending spec, else empty
// (defaults come from the shared descriptor client-side); `connected` = whether the backing
// connection is linked. Internal keys (backingParticipantId, email, account) are stripped.
export async function workflowIntegrationSettings(
  wf: db.WorkflowRow,
  owner: db.Participant,
): Promise<Record<string, { config: Record<string, unknown>; connected: boolean }>> {
  const { filterToSettableKeys, rosterIntegrationSettings } = await import("@jungle/shared");
  const seat = wf.roster[0];
  if (!seat) return {};
  const keys = seat.integrations ?? [];
  const seatId = seat.participant_id;
  const attached = seatId ? await db.listAgentIntegrations(seatId) : [];
  const attachedByKey = new Map(attached.map((r) => [r.integration_key, r]));
  const conn = await connectionStatus(owner, keys);
  const connectedByKey = new Map(conn.map((c) => [c.key, c.connected]));
  const out: Record<string, { config: Record<string, unknown>; connected: boolean }> = {};
  for (const key of keys) {
    const live = attachedByKey.get(key);
    const config = live
      ? filterToSettableKeys(key, live.config)
      : rosterIntegrationSettings(seat, key); // pending: show the wished-for spec
    out[key] = { config, connected: connectedByKey.get(key) ?? false };
  }
  return out;
}

const KEY_LABELS: Record<string, string> = {
  gmail: "Gmail",
  "google-calendar": "Google Calendar",
  "google-drive": "Google Drive",
  github: "GitHub",
  x: "X (Twitter)",
  linear: "Linear",
  notion: "Notion",
  granola: "Granola",
  posthog: "PostHog",
  mixpanel: "Mixpanel",
};

// Returns the text it posted, so the caller can record it in conversation memory.
async function createDraftAndPostCard(
  install: db.LianaInstall,
  owner: db.Participant,
  slackUserId: string,
  spec: IntakeWorkflowSpec,
  profile: slack.SlackUserProfile | null,
  reply: { channel: string; threadTs: string | null },
  replySentence: string,
): Promise<string> {
  // With conversation memory, "actually make it 9am" re-drafts — the new draft supersedes any
  // unconfirmed one from this same conversation instead of stacking cards that all still work.
  const stale = await db.listLianaDraftsByOrigin(owner.id, reply.channel, reply.threadTs);
  for (const s of stale) await cancelLianaDraft(s.workflow_id).catch(() => {});

  const { wf } = await createLianaDraft({
    owner,
    teamId: install.team_id,
    slackUserId,
    spec,
    defaultTz: profile?.tz ?? null,
    origin: { channel: reply.channel, threadTs: reply.threadTs },
  });

  const statuses = await connectionStatus(owner, spec.integrations);
  const label = (key: string): string =>
    key === "github" && spec.repo ? `${KEY_LABELS[key] ?? key} — ${spec.repo}` : (KEY_LABELS[key] ?? key);
  const integrationLines = statuses.map((s) =>
    s.connected
      ? `:white_check_mark: ${label(s.key)}${s.key !== "github" && s.account ? ` — ${s.account}` : ""}`
      : `:link: ${label(s.key)} — connect in the web app after creating`,
  );
  const url = LIANA_WEB_URL;

  const detail =
    `*${wf.name}* — ${cadenceSentence(wf)}\n` +
    (integrationLines.length ? integrationLines.join("\n") : "_No integrations needed_") +
    `\n_${await slackDeliveryPhrase(install, reply.channel)}_`;

  await postReply(install, reply, `${replySentence}\n${detail}`, [
    { type: "section", text: { type: "mrkdwn", text: replySentence } },
    { type: "section", text: { type: "mrkdwn", text: detail } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Create it" },
          action_id: "liana_confirm",
          value: wf.id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          action_id: "liana_cancel",
          value: wf.id,
        },
        { type: "button", text: { type: "plain_text", text: "Open in Liana" }, url },
      ],
    },
  ]);
  return `${replySentence}\n${detail}`;
}

// ============================ Interactivity (confirm / cancel) ============================

interface BlockActionPayload {
  type?: string;
  team?: { id?: string };
  user?: { id?: string };
  response_url?: string;
  actions?: { action_id?: string; value?: string }[];
}

export async function handleInteractivity(payload: BlockActionPayload): Promise<void> {
  if (payload.type !== "block_actions") return;
  const action = payload.actions?.[0];
  const workflowId = action?.value;
  const responseUrl = payload.response_url;
  if (!action?.action_id || !workflowId || !responseUrl) return;

  // Grab the ownership row up front: cancel deletes it, and we want the origin conversation for
  // the memory note either way. A missing row means the draft was superseded by a newer one.
  const row = await db.getLianaWorkflow(workflowId);
  if (!row) {
    await respondViaUrl(responseUrl, {
      replace_original: false,
      text: "That draft was replaced by a newer one — use the buttons on the latest message.",
    }).catch(() => {});
    return;
  }
  const noteConvo = row.origin_channel_id
    ? row.origin_thread_ts
      ? `slack:${row.origin_channel_id}:${row.origin_thread_ts}`
      : `slack:${row.origin_channel_id}`
    : null;

  try {
    if (action.action_id === "liana_confirm") {
      const result = await confirmLianaWorkflow(workflowId);
      const install = row.team_id ? await db.getLianaInstall(row.team_id) : null;
      const phrase =
        install && row.origin_channel_id ? await slackDeliveryPhrase(install, row.origin_channel_id) : "Runs come to your DMs.";
      await respondViaUrl(responseUrl, {
        replace_original: true,
        text:
          `:seedling: *${result.wf.name}* is live — ${cadenceSentence(result.wf)}. ` +
          `${firstRunNotice(result.wf)} ${phrase}` +
          (result.unconnected.length
            ? `\n:link: Heads up: connect ${result.unconnected.map((k) => KEY_LABELS[k] ?? k).join(", ")} in <${result.url}|the web app> so I can use ${result.unconnected.length > 1 ? "them" : "it"}.`
            : ""),
      });
      if (noteConvo) await remember(row.owner_participant_id, noteConvo, "assistant", `Workflow "${result.wf.name}" was confirmed and is now live.`);
    } else if (action.action_id === "liana_cancel") {
      await cancelLianaDraft(workflowId);
      await respondViaUrl(responseUrl, { replace_original: true, text: "No problem — canceled." });
      if (noteConvo) await remember(row.owner_participant_id, noteConvo, "assistant", `The draft workflow was canceled.`);
    }
  } catch (e) {
    console.error("liana interactivity:", e);
    await respondViaUrl(responseUrl, {
      replace_original: false,
      text: `Couldn't do that: ${e instanceof ApiError ? e.message : "something went wrong."}`,
    }).catch(() => {});
  }
}

async function respondViaUrl(responseUrl: string, body: Record<string, unknown>): Promise<void> {
  const resp = await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`response_url ${resp.status}`);
}

export async function confirmLianaWorkflow(
  workflowId: string,
): Promise<{ wf: db.WorkflowRow; unconnected: string[]; url: string }> {
  const wf = await db.getWorkflow(workflowId);
  const liana = await db.getLianaWorkflow(workflowId);
  if (!wf || !liana) throw new ApiError(404, "workflow not found");
  if (wf.status !== "draft") throw new ApiError(400, "already created");
  const owner = await db.getParticipant(liana.owner_participant_id);
  if (!owner) throw new ApiError(404, "owner not found");

  const finalized = await workflows.finalizeWorkflow(wf, owner);

  // Stamp the owner's default workflow model onto the (just-materialized) seat agent before the
  // first run, so the very first turn already runs on it.
  const seatId = finalized.roster[0]?.participant_id;
  if (seatId) {
    await db.updateAgentConfig(seatId, { model: await workflowModelFor(owner.id) });
  }

  // Instant first run: never make someone wait until 8am for their first payoff. A one-time
  // workflow is the exception — its whole point is to fire once at the chosen time, so we let the
  // backing schedule (created in finalize) do it rather than running immediately.
  if (finalized.trigger.type !== "once") {
    try {
      await workflows.startRun(finalized, "manual");
    } catch (e) {
      console.error(`liana: first run of ${workflowId} failed to start:`, e);
    }
  }

  const statuses = await connectionStatus(owner, finalized.roster[0]?.integrations ?? []);
  return {
    wf: finalized,
    unconnected: statuses.filter((s) => !s.connected).map((s) => s.key),
    url: LIANA_WEB_URL,
  };
}

export async function cancelLianaDraft(workflowId: string): Promise<void> {
  const wf = await db.getWorkflow(workflowId);
  if (!wf) return;
  if (wf.status !== "draft") throw new ApiError(400, "workflow is already live — manage it in the web app");
  await workflows.cleanupDraftAgents(wf);
  await db.deleteWorkflow(wf.id);
}

// ============================ iMessage channel ============================

// Phone linking (web Settings): text a 6-digit code, confirm it in the web app.
export async function startPhoneVerify(me: db.Participant, rawPhone: string): Promise<void> {
  if (!imsg.imessageConfigured()) throw new ApiError(400, "iMessage isn't enabled on this deployment");
  const phone = imsg.normalizePhone(rawPhone);
  if (!phone) throw new ApiError(400, "enter a valid phone number (with country code if outside the US)");
  const existing = await db.getPhoneLinkByPhone(phone);
  if (existing && existing.participant_id !== me.id) {
    throw new ApiError(409, "that number is linked to a different Liana account");
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await db.upsertPhoneLink(me.id, phone, code, new Date(Date.now() + 10 * 60_000).toISOString());
  await imsg.sendIMessage(phone, `Your Liana verification code is ${code}. It expires in 10 minutes.`);
}

export async function confirmPhoneVerify(me: db.Participant, code: string): Promise<db.LianaPhoneLink> {
  const link = await db.getPhoneLink(me.id);
  if (!link || !link.verify_code) throw new ApiError(400, "start verification first");
  if (!link.verify_expires_at || new Date(link.verify_expires_at).getTime() < Date.now()) {
    throw new ApiError(400, "that code expired — request a new one");
  }
  if (link.verify_code !== code.trim()) throw new ApiError(400, "that code doesn't match");
  await db.markPhoneVerified(me.id);
  await imsg
    .sendIMessage(link.phone, "🌿 You're linked. Text me what you'd like automated — try \"morning briefing every day at 8am\".")
    .catch(() => {});
  return (await db.getPhoneLink(me.id))!;
}

const YES_RE = /^\s*(yes|y|yep|yeah|confirm|create( it)?|do it|go|👍)\s*[.!]*\s*$/i;
const NO_RE = /^\s*(no|n|nope|cancel|stop|nevermind|never mind)\s*[.!]*\s*$/i;

// One brain for every buttonless chat surface (iMessage, Telegram): pending-draft YES/NO
// confirm, then the same intake as Slack. Channel specifics — how to reply, where pending-draft
// state lives, which delivery channel new drafts default to — come in via ctx.
interface ConversationalCtx {
  owner: db.Participant;
  install: db.LianaInstall | null; // null: an account with no Slack install (web/iMessage/Telegram only)
  channel: DeliveryChannel; // new drafts deliver here — "Liana answers where you ask"
  convoKey: string; // conversation-scoped memory key, e.g. "imessage:+15551234567"
  pendingDraftId: string | null;
  reply: (text: string) => Promise<void>;
  setPendingDraft: (draftId: string | null) => Promise<void>;
  toPlain: (md: string) => string; // channel's markdown handling for freeform intake replies
  // Where runs from a draft born here will land — one plain sentence for the confirm card, so the
  // destination is never a surprise (esp. group chats). e.g. "Runs post here in this group."
  deliveryPhrase?: string;
  // The Telegram chat a group/DM draft should deliver to (records origin_telegram_chat_id).
  originTelegramChatId?: number | null;
  // Buttoned confirm (Telegram): render the draft card with inline Create it / Cancel buttons
  // instead of a typed YES/NO prompt. Required in groups, where privacy mode drops bare replies.
  confirmCard?: (cardText: string, workflowId: string) => Promise<void>;
  // Native "typing…" indicator for this surface (auto-clears when we send the reply); fired once
  // before the slow intake turn. Best-effort — a typing failure must not break the turn.
  startTyping?: () => Promise<void>;
  // The external surface a reply from this turn should route back to, for the agent path. Set by
  // each entrypoint (it knows its chat/phone). When the rollout flag is on, the turn is handed to
  // the owner's persistent Liana agent instead of the stateless intake.
  agentSurface?: db.LianaSurface;
}

// Reply + record in the conversation's memory in one motion.
async function replyAndRemember(ctx: ConversationalCtx, text: string): Promise<void> {
  await ctx.reply(text);
  await remember(ctx.owner.id, ctx.convoKey, "assistant", text);
}

async function handleConversationalTurn(text: string, ctx: ConversationalCtx): Promise<void> {
  const { owner, install } = ctx;

  // Account gate: links minted before the sign-in era can point at shadow participants.
  if (!owner.firebase_uid) {
    await ctx.reply(
      `Almost there — Liana now uses accounts. Create yours at ${LIANA_WEB_URL} (one click with Google), then text me again.`,
    );
    return;
  }

  // Signal we're on it before the slow work (intake LLM, or a first run on YES). The indicator
  // clears itself when our reply lands, so one fire up front covers the whole turn.
  await ctx.startTyping?.();

  // Agent path (rollout flag): hand the turn to the owner's persistent Liana agent, which replies
  // asynchronously via send_message -> deliverToLianaSurface. Bypasses the typed YES/NO draft
  // confirm (the agent manages its own drafts via workflow_* tools).
  if (ctx.agentSurface && (await lianaAgentEnabled(owner.id))) {
    await dispatchToLianaAgent(owner, text, ctx.agentSurface);
    return;
  }

  const slackUserId = install ? await db.getSlackUserIdForParticipant(install.team_id, owner.id) : null;
  const history = await db.recentLianaMessages(owner.id, ctx.convoKey);
  await remember(owner.id, ctx.convoKey, "user", text);

  // Pending draft: YES/NO resolves it; anything else falls through to a fresh intake turn
  // (which replaces the pending draft if it drafts a new workflow).
  if (ctx.pendingDraftId) {
    if (YES_RE.test(text)) {
      const draftId = ctx.pendingDraftId;
      await ctx.setPendingDraft(null);
      const result = await confirmLianaWorkflow(draftId);
      await replyAndRemember(
        ctx,
        `🌿 ${result.wf.name} is live — ${cadenceSentence(result.wf)}. ${firstRunNotice(result.wf)}` +
          (result.unconnected.length
            ? `\nHeads up: connect ${result.unconnected.map((k) => KEY_LABELS[k] ?? k).join(", ")} so I can use ${result.unconnected.length > 1 ? "them" : "it"}: ${result.url}`
            : ""),
      );
      return;
    }
    if (NO_RE.test(text)) {
      const draftId = ctx.pendingDraftId;
      await ctx.setPendingDraft(null);
      await cancelLianaDraft(draftId).catch(() => {});
      await replyAndRemember(ctx, "No problem — canceled.");
      return;
    }
  }

  const existing = await describeOwnerWorkflows(owner.id);
  // No Slack profile on this surface (iMessage/Telegram), so use the same default zone that draft
  // creation falls back to (defaultTz: null → DEFAULT_TZ) — intake and creation must share a clock.
  const intake = await runIntake(
    text,
    {
      userName: owner.display_name,
      userTz: DEFAULT_TZ,
      now: formatNow(DEFAULT_TZ),
      existingWorkflows: existing.map((w) => w.line),
      history,
    },
    await intakeModelFor(owner.id),
  );

  if (intake.intent === "list_workflows") {
    if (!existing.length) {
      await replyAndRemember(ctx, `You don't have any workflows yet. Try: "morning briefing every day at 8am".`);
    } else {
      const lines = existing.map((w) => `• ${w.wf.name} — ${cadenceSentence(w.wf)}${w.wf.status === "paused" ? " (paused)" : ""}`);
      await replyAndRemember(ctx, `Your workflows:\n${lines.join("\n")}\nManage them: ${LIANA_WEB_URL}`);
    }
    return;
  }

  if (intake.intent === "edit_workflow" && intake.edit) {
    const sentence = await applyIntakeEdit(owner, existing, intake.edit, intake.reply);
    await replyAndRemember(ctx, ctx.toPlain(sentence));
    return;
  }

  if (intake.intent === "create_workflow" && intake.workflow) {
    // Slot-fill: github with no repo → ask which one instead of drafting a git-less workflow.
    const ask = await githubRepoGuard(owner, intake.workflow);
    if (ask) {
      await replyAndRemember(ctx, ctx.toPlain(ask));
      return;
    }
    // A new draft replaces any dangling pending one.
    if (ctx.pendingDraftId) {
      await cancelLianaDraft(ctx.pendingDraftId).catch(() => {});
      await ctx.setPendingDraft(null);
    }
    const { wf } = await createLianaDraft({
      owner,
      teamId: install?.team_id ?? null,
      slackUserId,
      spec: intake.workflow,
      defaultTz: null,
      deliverTo: [ctx.channel],
      originTelegramChatId: ctx.originTelegramChatId ?? null,
    });
    const statuses = await connectionStatus(owner, intake.workflow.integrations);
    const wfLabel = (key: string): string =>
      key === "github" && intake.workflow!.repo ? `${KEY_LABELS[key] ?? key} — ${intake.workflow!.repo}` : (KEY_LABELS[key] ?? key);
    const integrationLines = statuses.map((s) =>
      s.connected ? `✓ ${wfLabel(s.key)}` : `→ ${wfLabel(s.key)} (connect on the web)`,
    );
    const card =
      `${intake.reply}\n\n${wf.name} — ${cadenceSentence(wf)}` +
      (integrationLines.length ? `\n${integrationLines.join("\n")}` : "") +
      (ctx.deliveryPhrase ? `\n\n${ctx.deliveryPhrase}` : "");
    if (ctx.confirmCard) {
      // Buttoned surface (Telegram): the buttons carry the id, so no per-user pending state needed.
      await ctx.confirmCard(card, wf.id);
      await remember(owner.id, ctx.convoKey, "assistant", card);
    } else {
      await ctx.setPendingDraft(wf.id);
      await replyAndRemember(ctx, `${card}\n\nReply YES to create it, or NO to cancel.`);
    }
    return;
  }

  await replyAndRemember(ctx, ctx.toPlain(intake.reply));
}

// Inbound text from a linked phone. Unaccounted numbers get one pointer to account creation
// (deduped upstream, so no loops).
export async function processIMessageInbound(inbound: imsg.InboundText): Promise<void> {
  const link = await db.getPhoneLinkByPhone(inbound.fromPhone);
  if (!link || !link.verified_at) {
    await imsg
      .sendIMessage(
        inbound.fromPhone,
        `Hi! I'm Liana — I set up workflows that run themselves. First, create your account (one click with Google) and link this number: ${LIANA_WEB_URL}`,
      )
      .catch((e) => console.error("liana imessage: unlinked reply failed:", e));
    return;
  }
  if (inbound.chatId && inbound.chatId !== link.linq_chat_id) {
    await db.setPhoneLinqChat(link.participant_id, inbound.chatId).catch(() => {});
  }

  const reply = (text: string) => imsg.sendIMessage(link.phone, text);
  try {
    const owner = await db.getParticipant(link.participant_id);
    if (!owner) throw new Error("phone link points at a missing participant");
    const install = await db.getLianaInstallByWorkspace(owner.workspace_id);
    const typingChatId = inbound.chatId ?? link.linq_chat_id;
    await handleConversationalTurn(inbound.text, {
      owner,
      install,
      channel: "imessage",
      convoKey: `imessage:${link.phone}`,
      pendingDraftId: link.pending_draft_id,
      reply,
      setPendingDraft: (id) => db.setPhonePendingDraft(owner.id, id),
      toPlain: imsg.toPlainText,
      startTyping: () => imsg.startTyping(typingChatId),
      agentSurface: { kind: "imessage", phone: link.phone },
    });
  } catch (e) {
    console.error("liana imessage inbound:", e);
    await reply("Something went wrong on my end — mind trying that again?").catch(() => {});
  }
}

// ============================ Telegram channel ============================

// Linking (web Settings): mint a code, hand back a t.me deep link; the bot's /start handler
// completes the bind. No code typing — pressing Start in Telegram IS the verification (only the
// person who opened the link can send it).
export async function startTelegramLink(me: db.Participant): Promise<string> {
  if (!tg.telegramConfigured()) throw new ApiError(400, "Telegram isn't enabled on this deployment");
  const code = randomBytes(16).toString("hex"); // 32 chars — within the 64-char /start payload limit
  await db.upsertTelegramLinkCode(me.id, code, new Date(Date.now() + 15 * 60_000).toISOString());
  return `https://t.me/${await tg.getBotUsername()}?start=${code}`;
}

// Inline buttons for a Telegram draft card. callback_data stays short (<=64 bytes): a two-char
// action tag + the workflow uuid.
function telegramConfirmButtons(workflowId: string): tg.TelegramButton[] {
  return [
    { text: "Create it", data: `lc:${workflowId}` },
    { text: "Cancel", data: `lx:${workflowId}` },
  ];
}

export async function processTelegramInbound(inbound: tg.TelegramInbound): Promise<void> {
  if (inbound.isGroup) return processTelegramGroupInbound(inbound);

  const reply = (text: string) => tg.sendTelegram(inbound.chatId, text);

  // Deep-link /start: complete the link minted in web Settings.
  if (inbound.startPayload !== null) {
    try {
      if (inbound.startPayload) {
        const linked = await db.completeTelegramLink({
          code: inbound.startPayload,
          chatId: inbound.chatId,
          telegramUserId: inbound.fromId,
          username: inbound.username,
        });
        if (linked) {
          await reply(`🌿 You're linked. Message me what you'd like automated — try "morning briefing every day at 8am".`);
          return;
        }
      }
      const existing = await db.getTelegramLinkByChat(inbound.chatId);
      await reply(
        existing?.verified_at
          ? "You're already linked. Tell me what you'd like automated!"
          : `That link is expired or already used — sign in and get a fresh one: ${LIANA_WEB_URL}/settings`,
      );
    } catch (e) {
      console.error("liana telegram /start:", e);
    }
    return;
  }

  const link = await db.getTelegramLinkByChat(inbound.chatId);
  if (!link || !link.verified_at) {
    await reply(
      `Hi! I'm Liana — I set up workflows that run themselves. First, create your account (one click with Google) and link Telegram: ${LIANA_WEB_URL}`,
    ).catch((e) => console.error("liana telegram: unlinked reply failed:", e));
    return;
  }

  try {
    const owner = await db.getParticipant(link.participant_id);
    if (!owner) throw new Error("telegram link points at a missing participant");
    const install = await db.getLianaInstallByWorkspace(owner.workspace_id);
    await handleConversationalTurn(inbound.text, {
      owner,
      install,
      channel: "telegram",
      convoKey: `telegram:${inbound.chatId}`,
      pendingDraftId: link.pending_draft_id,
      reply,
      setPendingDraft: (id) => db.setTelegramPendingDraft(owner.id, id),
      toPlain: (md) => md, // sendTelegram renders light markdown itself
      deliveryPhrase: "Runs land here in this chat.",
      agentSurface: { kind: "telegram", chatId: String(inbound.chatId) },
      confirmCard: async (cardText, wfId) => {
        await tg.sendTelegramButtons(inbound.chatId, cardText, telegramConfirmButtons(wfId));
      },
      startTyping: () => tg.sendTyping(inbound.chatId),
    });
  } catch (e) {
    console.error("liana telegram inbound:", e);
    await reply("Something went wrong on my end — mind trying that again?").catch(() => {});
  }
}

// A message in a Telegram group/supergroup. Groups have many people, so the owner is resolved by
// the SENDER's Telegram user id (they must have DM-linked their account first), and runs deliver
// back to the group chat. Confirm is via inline buttons — privacy mode drops bare typed replies.
async function processTelegramGroupInbound(inbound: tg.TelegramInbound): Promise<void> {
  const botUsername = await tg.getBotUsername();
  const { addressed, text } = tg.addressedInGroup(inbound, botUsername);
  if (!addressed) return; // group chatter not directed at us

  try {
    const link = await db.getTelegramLinkByUser(inbound.fromId);
    if (!link?.participant_id) {
      // Unlinked sender: one short pointer (deduped by Telegram's per-update delivery — no loop).
      await tg.sendTelegram(
        inbound.chatId,
        `Hi! DM me to link your Liana account first, then @${botUsername} me here. → https://t.me/${botUsername}`,
      );
      return;
    }
    const owner = await db.getParticipant(link.participant_id);
    if (!owner) throw new Error("telegram group: link points at a missing participant");
    if (!text) {
      await tg.sendTelegram(inbound.chatId, `Tell me what to automate — e.g. "@${botUsername} morning briefing every day at 8am".`);
      return;
    }
    const install = await db.getLianaInstallByWorkspace(owner.workspace_id);
    await handleConversationalTurn(text, {
      owner,
      install,
      channel: "telegram",
      convoKey: `telegram:${inbound.chatId}:${inbound.fromId}`, // per-user within a group
      pendingDraftId: null, // groups confirm with buttons, not typed YES/NO
      reply: (t) => tg.sendTelegram(inbound.chatId, t),
      setPendingDraft: async () => {}, // buttons carry the id; no per-user pending state in groups
      toPlain: (md) => md,
      deliveryPhrase: "Runs post here in this group.",
      originTelegramChatId: inbound.chatId,
      agentSurface: { kind: "telegram", chatId: String(inbound.chatId) },
      confirmCard: async (cardText, wfId) => {
        await tg.sendTelegramButtons(inbound.chatId, cardText, telegramConfirmButtons(wfId));
      },
      startTyping: () => tg.sendTyping(inbound.chatId),
    });
  } catch (e) {
    console.error("liana telegram group inbound:", e);
    await tg.sendTelegram(inbound.chatId, "Something went wrong on my end — mind trying that again?").catch(() => {});
  }
}

// A tapped Create it / Cancel button on a Telegram draft card (group or DM). Only the person who
// set the draft up can act on it — buttons are visible to a whole group.
export async function processTelegramCallback(cb: tg.TelegramCallback): Promise<void> {
  const m = /^(lc|lx):(.+)$/.exec(cb.data);
  if (!m) {
    await tg.answerCallbackQuery(cb.callbackQueryId);
    return;
  }
  const [, action, workflowId] = m;
  try {
    const row = await db.getLianaWorkflow(workflowId);
    if (!row) {
      await tg.answerCallbackQuery(cb.callbackQueryId, "That draft is no longer available.");
      await tg.editMessageText(cb.chatId, cb.messageId, "_That draft is no longer available._").catch(() => {});
      return;
    }
    const tapper = await db.getTelegramLinkByUser(cb.fromId);
    if (!tapper || tapper.participant_id !== row.owner_participant_id) {
      await tg.answerCallbackQuery(cb.callbackQueryId, "Only the person who set this up can do that.");
      return;
    }
    await db.setTelegramPendingDraft(row.owner_participant_id, null).catch(() => {});

    if (action === "lc") {
      const result = await confirmLianaWorkflow(workflowId);
      await tg.answerCallbackQuery(cb.callbackQueryId, "Creating…");
      await tg.editMessageText(
        cb.chatId,
        cb.messageId,
        `🌿 ${result.wf.name} is live — ${cadenceSentence(result.wf)}. ${firstRunNotice(result.wf)}` +
          (result.unconnected.length
            ? `\nHeads up: connect ${result.unconnected.map((k) => KEY_LABELS[k] ?? k).join(", ")} so I can use ${result.unconnected.length > 1 ? "them" : "it"}: ${result.url}`
            : ""),
      );
    } else {
      await cancelLianaDraft(workflowId).catch(() => {});
      await tg.answerCallbackQuery(cb.callbackQueryId, "Canceled");
      await tg.editMessageText(cb.chatId, cb.messageId, "No problem — canceled.");
    }
  } catch (e) {
    console.error("liana telegram callback:", e);
    await tg.answerCallbackQuery(cb.callbackQueryId, "Something went wrong — try again.");
  }
}

// Channel status for the web app (Settings). iMessage is absent entirely when the deployment
// has no provider configured — no dead UI.
export async function channelStatus(me: db.Participant, install: db.LianaInstall | null) {
  const out: Record<string, unknown> = {
    slack: { connected: !!install, teamName: install?.team_name ?? null },
  };
  if (imsg.imessageConfigured()) {
    const link = await db.getPhoneLink(me.id);
    out.imessage = {
      phone: link?.phone ?? null,
      verified: !!link?.verified_at,
      pendingCode: !!link && !link.verified_at && !!link.verify_code,
    };
  }
  if (tg.telegramConfigured()) {
    const link = await db.getTelegramLink(me.id);
    out.telegram = {
      linked: !!link?.verified_at,
      username: link?.telegram_username ?? null,
    };
  }
  return out;
}

// ============================ Run delivery (workflows.ts hooks in here on run close) ============================

const RUN_COMPLETE_RE = /^(?:✅\s*)?run\s+complete\b/i;

export async function onRunClosed(runId: string): Promise<void> {
  const run = await db.getWorkflowRun(runId);
  if (!run) return;
  const liana = await db.getLianaWorkflow(run.workflow_id);
  if (!liana) return; // not a Liana workflow — nothing to deliver
  // Slack context is optional (accounts without an install deliver over iMessage/Telegram only).
  const install = liana.team_id ? await db.getLianaInstall(liana.team_id) : null;
  const wf = await db.getWorkflow(run.workflow_id);
  if (!wf) return;

  if (!(await db.claimLianaDelivery(run.id))) return; // already delivered

  const owner = await db.getParticipant(liana.owner_participant_id);
  const url = LIANA_WEB_URL;
  const date = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(new Date());

  let body: string;
  if (run.status === "done") {
    const deliverable = await collectDeliverable(run, wf);
    body = `*${wf.name}* · ${date}\n\n${deliverable}`;
  } else {
    body = `*${wf.name}* · ${date}\n\n:warning: This run didn't finish cleanly (${run.status}). You can check it or run it again in <${url}|Liana>.`;
  }
  const MAX = 11000; // Slack chat.postMessage text limit is 40k; keep messages readable
  if (body.length > MAX) body = body.slice(0, MAX) + `\n\n_…truncated — <${url}|read the full run in Liana>_`;

  // Fan out to each enabled channel independently: one channel failing must not block the other,
  // and the per-run claim above keeps the whole delivery idempotent. `outcomes` records what
  // happened per channel (ok / skipped / failed) so the user can see it — a silently-skipped
  // channel (provider not configured, no verified link) used to leave no trace at all.
  const channels = liana.deliver_to?.length ? liana.deliver_to : ["slack"];
  const outcomes: Record<string, string> = {};
  const failures: string[] = []; // genuine non-deliveries → status rollup + error column

  // After a successful send, drop a one-line stub into that conversation's memory — enough for
  // "add calendar to that" to resolve, without dragging a whole briefing into every intake call.
  const stub = `[Delivered a "${wf.name}" run]`;

  if (channels.includes("slack")) {
    try {
      if (!install || install.status !== "active" || !liana.slack_user_id) throw new Error("no active Slack install for this workflow");
      const slackUserId = liana.slack_user_id; // captured so the closure keeps the narrowed type
      const openDm = async (): Promise<string> => {
        let dm = liana.dm_channel_id;
        if (!dm) {
          dm = (await slack.conversationsOpen(install.bot_token, slackUserId)).id;
          await db.setLianaDmChannel(liana.workflow_id, dm);
        }
        return dm;
      };
      // "Liana answers where you ask": deliver to the channel the workflow was invoked in (a fresh
      // top-level message each run), unless it was created without an origin (web/legacy) or the
      // owner switched it to DM-only on the web.
      const useChannel = !liana.deliver_dm_override && !!liana.origin_channel_id;
      const target = useChannel ? liana.origin_channel_id! : await openDm();
      try {
        await slack.chatPostMessage(install.bot_token, { channel: target, text: jungleToSlackText(body) });
        if (owner) await remember(owner.id, `slack:${target}`, "assistant", stub);
        outcomes.slack = "ok";
      } catch (e) {
        // Bot removed from the channel / channel gone: fall back to the DM so the run isn't lost.
        // This still counts as delivered (not a failure) — just note where it landed.
        if (useChannel && e instanceof slack.SlackApiError && slack.FATAL_SLACK_ERRORS.has(e.code)) {
          const dm = await openDm();
          await slack.chatPostMessage(install.bot_token, { channel: dm, text: jungleToSlackText(body) });
          if (owner) await remember(owner.id, `slack:${dm}`, "assistant", stub);
          outcomes.slack = `ok (channel unavailable [${e.code}] — sent to your DM)`;
        } else {
          throw e;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      outcomes.slack = `failed: ${msg}`;
      failures.push(`slack: ${msg}`);
    }
  }

  if (channels.includes("imessage")) {
    if (!imsg.imessageConfigured()) {
      outcomes.imessage = "skipped: iMessage not configured on this deployment";
    } else {
      try {
        const link = owner ? await db.getPhoneLink(owner.id) : null;
        if (link?.verified_at) {
          await imsg.sendIMessage(link.phone, imsg.toPlainText(capForChannel(body, IMSG_MAX, url)));
          if (owner) await remember(owner.id, `imessage:${link.phone}`, "assistant", stub);
          outcomes.imessage = "ok";
        } else {
          outcomes.imessage = "skipped: no verified phone linked";
          failures.push("imessage: no verified phone linked");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        outcomes.imessage = `failed: ${msg}`;
        failures.push(`imessage: ${msg}`);
      }
    }
  }

  if (channels.includes("telegram")) {
    if (!tg.telegramConfigured()) {
      outcomes.telegram = "skipped: Telegram not configured on this deployment";
    } else {
      try {
        const link = owner ? await db.getTelegramLink(owner.id) : null;
        // Deliver to the chat the workflow was set up in (a group, or the DM), unless switched to
        // DM-only on the web — then fall back to the owner's private link chat.
        const groupChat = !liana.deliver_dm_override ? liana.origin_telegram_chat_id : null;
        const chatId = groupChat ?? (link?.verified_at ? link.chat_id : null);
        if (chatId) {
          await tg.sendTelegram(chatId, body);
          if (owner) await remember(owner.id, `telegram:${chatId}`, "assistant", stub);
          outcomes.telegram = "ok";
        } else {
          outcomes.telegram = "skipped: no linked Telegram account";
          failures.push("telegram: no linked Telegram account");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        outcomes.telegram = `failed: ${msg}`;
        failures.push(`telegram: ${msg}`);
      }
    }
  }

  await db.recordLianaDeliveryChannels(runId, outcomes).catch(() => {});
  if (failures.length) {
    console.error(`liana: delivery for run ${runId} had issues:`, failures.join(" | "));
    await db.markLianaDeliveryFailed(runId, failures.join(" | ")).catch(() => {});
  }
}

// iMessage keeps bubbles short: hard-cap the plain-text body and point at the full run in Liana.
// (Linq's behavior on very long messages is unverified; a link is safer than a wall of text.)
const IMSG_MAX = 1500;
function capForChannel(body: string, max: number, url: string): string {
  if (body.length <= max) return body;
  return body.slice(0, max) + `\n\nFull run: ${url}`;
}

// The deliverable = the workflow agent's thread messages, minus the run header and the
// "Run complete:" sentinel. Falls back to the run summary when the agent merged everything
// into the completion message.
async function collectDeliverable(run: db.WorkflowRunRow, wf: db.WorkflowRow): Promise<string> {
  if (!run.root_message_id) return run.summary ?? "Run finished.";
  const memberIds = new Set(wf.roster.map((r) => r.participant_id).filter(Boolean));
  const msgs = await db.getThreadMessages(run.root_message_id);
  const bodies = msgs
    .filter((m) => m.id !== run.root_message_id)
    .filter((m) => memberIds.has(m.sender_id))
    .filter((m) => !RUN_COMPLETE_RE.test(m.body))
    .map((m) => m.body.trim())
    .filter(Boolean);
  if (bodies.length) return bodies.join("\n\n");
  return run.summary ?? "Run finished (no output).";
}

// ============================ Web API helpers ============================

const PLAYBOOK_SUFFIX_MARK = "\n\n— How to run —\n";

// The user-facing prompt is the playbook minus the delivery boilerplate we append.
export function promptOf(wf: Pick<db.WorkflowRow, "playbook">): string {
  const i = wf.playbook.indexOf(PLAYBOOK_SUFFIX_MARK);
  return i === -1 ? wf.playbook : wf.playbook.slice(0, i);
}

// A run's deliverable text, for the web run history (same extraction as DM delivery).
export async function runDeliverableText(run: db.WorkflowRunRow, wf: db.WorkflowRow): Promise<string> {
  return collectDeliverable(run, wf);
}

// Where a workflow's runs land, for the web app: a human label plus whether a channel destination
// exists (so the "send to my DM instead" switch only shows when there's a channel to switch from)
// and whether that switch is currently on. Resolves the Slack channel name; a DM-origin Slack
// workflow reads as no-channel (nothing to switch away from).
export async function describeDelivery(
  row: db.LianaWorkflowRow,
): Promise<{ dmOnly: boolean; hasChannel: boolean; label: string }> {
  const dmOnly = row.deliver_dm_override;
  const dmLabel = row.deliver_to?.includes("telegram")
    ? "your Telegram chat"
    : row.deliver_to?.includes("imessage")
      ? "iMessage"
      : "your Slack DM";

  if (row.origin_channel_id && row.team_id) {
    const install = await db.getLianaInstall(row.team_id);
    if (install) {
      try {
        const info = await slack.conversationsInfo(install.bot_token, row.origin_channel_id);
        if (info.is_im) return { dmOnly, hasChannel: false, label: dmLabel }; // DM origin — no channel
        if (info.name) return { dmOnly, hasChannel: true, label: dmOnly ? dmLabel : `#${info.name}` };
      } catch {
        /* fall through */
      }
    }
    return { dmOnly, hasChannel: true, label: dmOnly ? dmLabel : "the channel you set it up in" };
  }
  if (row.origin_telegram_chat_id) {
    return { dmOnly, hasChannel: true, label: dmOnly ? dmLabel : "a Telegram group" };
  }
  return { dmOnly, hasChannel: false, label: dmLabel };
}

// The concrete model a workflow's agent runs on (null on drafts — the seat doesn't exist yet;
// the owner's default applies at confirm).
export async function workflowModel(wf: db.WorkflowRow): Promise<string | null> {
  const seatId = wf.roster[0]?.participant_id;
  if (!seatId) return null;
  return (await db.getParticipant(seatId))?.model ?? null;
}

// Per-workflow model override (web PATCH). Applies at the agent's next turn boundary — a live
// runner is told immediately, and the next run picks it up either way.
export async function setLianaWorkflowModel(wf: db.WorkflowRow, model: string): Promise<void> {
  if (!isAllowedModel(model)) throw new ApiError(400, `unsupported model: ${model}`);
  if (!providerConfigured(model)) {
    throw new ApiError(400, `model unavailable: ${model}'s provider API key is not configured`);
  }
  const seatId = wf.roster[0]?.participant_id;
  if (!seatId) throw new ApiError(400, "create the workflow first — drafts don't have an agent yet");
  await db.updateAgentConfig(seatId, { model });
  runners.setModel(seatId, model);
}

// Web PATCH: name / prompt / cadence / paused / integrations. Cadence edits keep the backing
// schedule row in sync (the ticker reads cron+next_run_at straight off it).
export async function editLianaWorkflow(
  wf: db.WorkflowRow,
  owner: db.Participant,
  args: {
    name?: string;
    prompt?: string;
    cron?: string | null; // null = switch to on-demand
    runAt?: string | null; // local "YYYY-MM-DDTHH:MM" for a one-time run; null = switch to on-demand
    timezone?: string;
    paused?: boolean;
    deliverTo?: string[];
    integrations?: string[];
    // Per-integration settings, keyed by integration key (e.g. { github: { repo: "acme/web" },
    // gmail: { requireSendApproval: false } }). Merge-per-integration: only the fields present are
    // touched. Keys may reference integrations being added in the same `integrations` edit.
    settings?: Record<string, Record<string, unknown>>;
  },
): Promise<{ workflow: db.WorkflowRow; warning?: string }> {
  if (args.cron != null && args.runAt != null) {
    throw new ApiError(400, "a workflow is either recurring (cron) or one-time (runAt), not both");
  }
  // Delivery channels newly added in this edit — pinged after the save to prove they work.
  let addedChannels: string[] = [];
  if (args.deliverTo !== undefined) {
    const channels = [...new Set(args.deliverTo)];
    if (!channels.length) throw new ApiError(400, "pick at least one delivery channel");
    for (const c of channels) {
      if (!(DELIVERY_CHANNELS as readonly string[]).includes(c)) throw new ApiError(400, `unknown channel: ${c}`);
    }
    if (channels.includes("imessage")) {
      if (!imsg.imessageConfigured()) throw new ApiError(400, "iMessage isn't enabled on this deployment");
      const link = await db.getPhoneLink(owner.id);
      if (!link?.verified_at) throw new ApiError(400, "verify your phone number in Settings first");
    }
    if (channels.includes("telegram")) {
      if (!tg.telegramConfigured()) throw new ApiError(400, "Telegram isn't enabled on this deployment");
      const link = await db.getTelegramLink(owner.id);
      if (!link?.verified_at) throw new ApiError(400, "link your Telegram account in Settings first");
    }
    const prior = await db.getLianaWorkflow(wf.id);
    const priorSet = new Set(prior?.deliver_to?.length ? prior.deliver_to : ["slack"]);
    addedChannels = channels.filter((c) => !priorSet.has(c));
    await db.setLianaDeliverTo(wf.id, channels);
  }
  const patch: Parameters<typeof db.updateWorkflow>[1] = {};
  let integrationsRemoved: string[] = [];
  // Keys whose config we must (re)write after the roster update: newly-added integrations + any
  // integration named in an explicit settings edit. Untouched integrations are left alone (so a
  // bare `integrations` edit never resets another integration's approval default).
  const keysToApply = new Set<string>();
  if (args.integrations !== undefined || args.settings !== undefined) {
    const seat = wf.roster[0];
    if (!seat) throw new ApiError(400, "workflow has no seat agent");
    const { getIntegrationType, settingsFor } = await import("@jungle/shared");

    const finalKeys =
      args.integrations !== undefined ? [...new Set(args.integrations.map(String))] : (seat.integrations ?? []);
    for (const k of finalKeys) {
      const type = getIntegrationType(k);
      if (!type || type.comingSoon) throw new ApiError(400, `unknown integration: ${k}`);
    }
    integrationsRemoved = (seat.integrations ?? []).filter((k) => !finalKeys.includes(k));
    for (const k of finalKeys) if (!(seat.integrations ?? []).includes(k)) keysToApply.add(k);

    // Merge explicit settings edits into the seat's settings spec (validate each field key against
    // the integration's descriptor so junk keys can't be smuggled into the config).
    const mergedSettings: Record<string, Record<string, unknown>> = { ...(seat.settings ?? {}) };
    for (const [k, fields] of Object.entries(args.settings ?? {})) {
      if (!finalKeys.includes(k)) throw new ApiError(400, `set up the ${k} integration before configuring it`);
      const allowed = new Set(settingsFor(k).map((s) => s.key));
      const clean: Record<string, unknown> = {};
      for (const [fk, fv] of Object.entries(fields ?? {})) {
        if (!allowed.has(fk)) throw new ApiError(400, `unknown ${k} setting: ${fk}`);
        clean[fk] = fv;
      }
      mergedSettings[k] = { ...(mergedSettings[k] ?? {}), ...clean };
      keysToApply.add(k);
    }
    // Drop settings for removed integrations; fold github.repo into the legacy top-level field.
    for (const k of integrationsRemoved) delete mergedSettings[k];
    const newSeat = { ...seat, integrations: finalKeys, settings: mergedSettings };
    const ghRepo = mergedSettings.github?.repo;
    if (finalKeys.includes("github") && typeof ghRepo === "string" && ghRepo) newSeat.repo = ghRepo;
    else if (!finalKeys.includes("github")) delete newSeat.repo;
    patch.roster = [newSeat, ...wf.roster.slice(1)];
  }
  if (args.name !== undefined) patch.name = workflows.validateName(args.name);
  if (args.prompt !== undefined) {
    const p = String(args.prompt).trim();
    if (!p) throw new ApiError(400, "prompt cannot be empty");
    patch.playbook = buildPlaybook(p);
  }

  if (args.cron !== undefined) {
    if (args.cron === null) {
      patch.trigger = { type: "manual" };
      // On-demand: drop the backing schedule row entirely (recreated if a cron comes back).
      await db.pool.query(`delete from schedules where workflow_id = $1`, [wf.id]);
    } else {
      const tz =
        args.timezone && isValidTimeZone(args.timezone)
          ? args.timezone
          : wf.trigger.type === "schedule"
            ? wf.trigger.timezone
            : DEFAULT_TZ;
      let nextRunAt: string;
      try {
        nextRunAt = computeNextRun(args.cron, tz);
      } catch {
        throw new ApiError(400, `invalid cron expression ${JSON.stringify(args.cron)}`);
      }
      patch.trigger = { type: "schedule", cron: args.cron, timezone: tz };
      const existing = await db.getWorkflowBackingSchedule(wf.id);
      if (existing) {
        await db.updateBackingScheduleCadence(wf.id, args.cron, tz, nextRunAt);
      } else if (wf.status !== "draft" && wf.home_channel_id && wf.roster[0]?.participant_id) {
        await db.createSchedule({
          workspaceId: wf.workspace_id,
          agentId: wf.roster[0].participant_id,
          channelId: wf.home_channel_id,
          createdBy: owner.id,
          prompt: `[workflow trigger] ${wf.name}`,
          cron: args.cron,
          timezone: tz,
          runAt: null,
          nextRunAt,
          workflowId: wf.id,
        });
      }
      // Re-scheduling a completed one-time workflow revives it.
      if (wf.status === "completed") patch.status = "active";
    }
  }

  // One-time cadence (mirrors the cron branch): a local wall-clock + tz resolved server-side to an
  // absolute instant, backed by a one-shot schedules row (run_at set, cron/timezone null).
  if (args.runAt !== undefined) {
    if (args.runAt === null) {
      patch.trigger = { type: "manual" };
      await db.pool.query(`delete from schedules where workflow_id = $1`, [wf.id]);
    } else {
      const tz =
        args.timezone && isValidTimeZone(args.timezone)
          ? args.timezone
          : wf.trigger.type === "once" || wf.trigger.type === "schedule"
            ? wf.trigger.timezone
            : DEFAULT_TZ;
      const runAt = resolveRunAt(args.runAt, tz);
      if (!runAt) throw new ApiError(400, "pick a future date and time");
      patch.trigger = { type: "once", runAt, timezone: tz };
      const existing = await db.getWorkflowBackingSchedule(wf.id);
      if (existing) {
        await db.updateBackingScheduleOnce(wf.id, runAt);
      } else if (wf.status !== "draft" && wf.home_channel_id && wf.roster[0]?.participant_id) {
        await db.createSchedule({
          workspaceId: wf.workspace_id,
          agentId: wf.roster[0].participant_id,
          channelId: wf.home_channel_id,
          createdBy: owner.id,
          prompt: `[workflow trigger] ${wf.name}`,
          cron: null,
          timezone: null,
          runAt,
          nextRunAt: runAt,
          workflowId: wf.id,
        });
      }
      if (wf.status === "completed") patch.status = "active";
    }
  }

  let updated = Object.keys(patch).length ? ((await db.updateWorkflow(wf.id, patch)) ?? wf) : wf;
  if (args.paused !== undefined && updated.status !== "draft") {
    updated = await workflows.setWorkflowPaused(updated, args.paused);
  }

  // Sync the seat agent with the integrations/settings edit: detach removed keys, then attach-or-
  // update the config for added keys + any explicitly-changed settings (unconnected keys stay
  // pending — startRun's self-heal picks them up once connected). Reconfigure a live runner only
  // when something actually changed. The roster spec (updated above) keeps the wish for pending keys.
  const seatId = updated.roster[0]?.participant_id;
  if ((args.integrations !== undefined || args.settings !== undefined) && seatId) {
    for (const k of integrationsRemoved) await db.removeAgentIntegration(seatId, k);
    const changed = keysToApply.size
      ? await workflows.applyIntegrationSettings(owner, seatId, [...keysToApply], updated.roster[0].settings ?? {})
      : 0;
    if (changed > 0 || integrationsRemoved.length > 0) void runners.reconfigure(seatId).catch(() => {});
  }

  // Channel-add confirmation ping: send a friendly one-liner to each newly-added delivery channel
  // so the user sees it works immediately (the iMessage incident: an added channel that silently
  // never delivered). Never blocks the save — a send failure comes back as a warning the caller
  // surfaces ("Saved — but the test message didn't send: …").
  const warning = addedChannels.length ? await pingAddedChannels(owner, updated, addedChannels) : undefined;
  return { workflow: updated, warning };
}

// Send the confirmation ping to each newly-added channel; returns a warning string if any failed.
async function pingAddedChannels(owner: db.Participant, wf: db.WorkflowRow, added: string[]): Promise<string | undefined> {
  const msg = `You'll get "${wf.name}" runs here from now on. 🌿`;
  const problems: string[] = [];
  for (const channel of added) {
    try {
      if (channel === "imessage") {
        const link = await db.getPhoneLink(owner.id);
        if (link?.verified_at) await imsg.sendIMessage(link.phone, msg);
      } else if (channel === "telegram") {
        const link = await db.getTelegramLink(owner.id);
        if (link?.verified_at && link.chat_id) await tg.sendTelegram(link.chat_id, msg);
      }
      // Slack is the default channel and always reachable via the app; no ping needed.
    } catch (e) {
      problems.push(`${channel} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return problems.length ? `couldn't send a test message to ${problems.join(", ")}` : undefined;
}

// ============================ OAuth install state ============================

const pendingInstallStates = new Map<string, number>(); // state -> createdAt
const STATE_TTL_MS = 15 * 60 * 1000;

export function newInstallState(): string {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, at] of pendingInstallStates) if (at < cutoff) pendingInstallStates.delete(k);
  const state = randomBytes(16).toString("hex");
  pendingInstallStates.set(state, Date.now());
  return state;
}

export function consumeInstallState(state: string): boolean {
  const at = pendingInstallStates.get(state);
  if (at === undefined) return false;
  pendingInstallStates.delete(state);
  return Date.now() - at <= STATE_TTL_MS;
}
