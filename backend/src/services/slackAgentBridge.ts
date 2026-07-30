import * as db from "../db";
import * as att from "../attachments";
import * as slack from "../slack/api";
import { slackToJungleText } from "../slack/format";
import { fanOut, DEFAULT_CASCADE_BUDGET } from "../ws/appSocket";
import { triggerMentionedAgents } from "./orchestrator";
import { resolveSlackParticipant } from "./slackBridge";
import { ensureJungleAgent } from "./jungleAgent";

// The Slack AGENT app: @jungle's DM in Slack. A separate Slack app from the channel mirror because
// `features.agent_view` is an irreversible per-app switch (see migrations/045_slack_agent_app.sql).
//
// The whole design goal here is to add a SURFACE, not a second brain. So a Slack DM with @jungle is
// bound to the SAME Jungle DM channel you'd see on the web:
//
//   Slack IM "D…"  <->  slack_channel_links row  <->  Jungle DM channel (person <-> @jungle)
//
// Because that binding is an ordinary link row, everything downstream already works:
//   - ingress reuses persistMessage + triggerMentionedAgents (a DM with no @mention wakes the
//     other member — orchestrator.ts:138 — which is exactly @jungle);
//   - egress reuses the transactional outbox verbatim (enqueueOutboxIfLinked -> claimDueOutbox ->
//     chat.postMessage), now joined to the install that owns the link so it posts as the right bot.
//
// There is no message streaming: the runner emits a COMPLETE message via send_message
// (shared/src/runner-protocol.ts), so there is no token delta to forward to chat.appendStream.
// Liveness comes from assistant.threads.setStatus while the turn runs.

interface AgentEventEnvelope {
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
    files?: { name?: string; title?: string }[];
  };
}

// Same rule as the mirror: only plain messages and file shares. Edits/deletes are out of scope
// (Jungle is insert-only) and bot_message is dropped as an echo.
const HANDLED_SUBTYPES = new Set([undefined, "file_share"] as (string | undefined)[]);

// Process one Events API callback from the AGENT app. Called after the route has acked 200.
// Self-contained error handling — never throws back to the route.
export async function processAgentAppEvent(payload: AgentEventEnvelope): Promise<void> {
  if (payload.type !== "event_callback" || !payload.event_id || !payload.team_id) return;
  const ev = payload.event;
  if (!ev) return;

  // Dedupe (Events API is at-least-once) BEFORE dispatching, so a retry can't double-post a turn.
  if (!(await db.recordSlackEvent(payload.event_id))) return;

  const install = await db.getSlackInstallByTeam(payload.team_id, "agent");
  if (!install || install.status !== "active") return;

  if (ev.type === "app_home_opened") {
    await publishAppHome(install, ev.user);
    return;
  }
  if (ev.type !== "message") return;
  if (ev.channel_type !== "im") return; // channels stay the mirror app's job — see below
  if (!ev.channel || !ev.ts) return;
  if (!HANDLED_SUBTYPES.has(ev.subtype)) return;

  // Echo drop: our own posts (and any other bot's) carry a bot_id. Also guard on our bot user id.
  if (ev.bot_id || !ev.user || ev.user === install.bot_user_id) return;

  await handleDirectMessage(install, payload.team_id, ev);
}

// A person messaged @jungle in Slack. Find (or build) the binding to their Jungle DM, then run the
// exact ingress trio a web post runs: persist -> fan out -> trigger.
async function handleDirectMessage(
  install: db.SlackInstall,
  teamId: string,
  ev: NonNullable<AgentEventEnvelope["event"]>,
): Promise<void> {
  const slackUserId = ev.user!;
  const sender = await resolveSlackParticipant(install, slackUserId);
  if (!sender) return;

  // @jungle is created with the workspace and backfilled at boot, but ensure it here too: this is
  // a front door, and "the agent doesn't exist yet" must never be a dead end.
  const agent = await ensureJungleAgent(install.workspace_id);

  const link = await ensureDmLink(install, teamId, ev.channel!, agent, sender, slackUserId);
  if (!link) return;

  // Thread mapping: a Slack in-thread reply targets the Jungle message its root maps to. Agent DMs
  // get real threads under agent_view, so without this a Slack thread would flatten into the DM.
  let threadRootId: string | null = null;
  if (ev.thread_ts && ev.thread_ts !== ev.ts) {
    const rootLink = await db.getMessageLinkBySlackTs(teamId, ev.channel!, ev.thread_ts);
    threadRootId = rootLink?.jungle_message_id ?? null;
  }

  const body = buildBody(ev);

  const msg = await db.persistMessage({
    channelId: link.jungle_channel_id,
    senderId: sender.id,
    body,
    clientMsgId: `slack:${teamId}:${ev.channel}:${ev.ts}`,
    cascadeBudget: DEFAULT_CASCADE_BUDGET,
    threadRootId,
    origin: "slack", // suppresses the outbox for THIS message; the agent's reply still goes out
  });
  await db.insertMessageLink({
    jungleMessageId: msg.id,
    teamId,
    slackChannelId: ev.channel!,
    slackTs: ev.ts!,
    slackThreadTs: ev.thread_ts ?? null,
    origin: "slack",
  });
  await fanOut(link.jungle_channel_id, { type: "message", message: att.withUrls(msg) });

  // "…is thinking" under the thread while the turn runs. Best-effort: Slack clears it when the
  // agent posts, and a failure here must never hold up the turn.
  void slack
    .setAssistantStatus(install.bot_token, ev.channel!, ev.thread_ts ?? ev.ts!, "is thinking…")
    .catch(() => {});

  // A DM with no @mention wakes the other member (orchestrator.ts:138) — that's @jungle.
  void triggerMentionedAgents(link.jungle_channel_id, msg, "human");
}

// Find-or-create the binding between this Slack IM and the person's Jungle DM with the agent.
// Idempotent: the DM channel itself is found-or-created (db.findOrCreateDm dedupes), and the link
// row is unique on jungle_channel_id.
async function ensureDmLink(
  install: db.SlackInstall,
  teamId: string,
  slackImChannelId: string,
  agent: db.Participant,
  person: db.Participant,
  slackUserId: string,
): Promise<db.SlackChannelLinkRow | null> {
  const existing = await db.getDmLink(agent.id, slackUserId);
  if (existing) return existing.status === "active" ? existing : null;

  const jungleChannelId = await db.findOrCreateDm(agent.id, person.id);

  // A link may already exist for this Jungle channel from an earlier bind (e.g. the Slack user was
  // re-resolved to a different participant). jungle_channel_id is unique, so reuse rather than
  // insert — otherwise every message would throw on the constraint.
  const byChannel = await db.getLinkByJungleChannel(jungleChannelId);
  if (byChannel) return byChannel.status === "active" ? byChannel : null;

  try {
    return await db.createChannelLink({
      workspaceId: install.workspace_id,
      jungleChannelId,
      slackTeamId: teamId,
      slackChannelId: slackImChannelId,
      slackChannelName: null,
      createdBy: person.id,
      installKind: "agent",
      dmAgentId: agent.id,
      dmSlackUserId: slackUserId,
    });
  } catch (e) {
    // Racing events from the same user (Slack delivers concurrently) can both miss the lookups
    // above; the loser just reuses the winner's row.
    const raced = await db.getDmLink(agent.id, slackUserId);
    if (raced) return raced;
    console.error("slack agent: could not bind DM", (e as Error).message);
    return null;
  }
}

// v1 mirrors files as a text note, not the bytes — same as the channel mirror. Slack @-mentions
// aren't resolved to Jungle handles here: in a 1:1 DM with @jungle there is nobody to mention but
// the bot itself, and resolving it would inject a self-mention into the body.
function buildBody(ev: NonNullable<AgentEventEnvelope["event"]>): string {
  let body = slackToJungleText(ev.text ?? "", () => null);
  for (const f of ev.files ?? []) {
    body += `\n📎 shared a file: ${f.name || f.title || "file"}`;
  }
  return body.trim() || "(empty message)";
}

// ============================ APP HOME ============================

// The App Home tab: a read-only roster of what this workspace has, with links into Jungle web.
// Deliberately not interactive — Slack is where you talk to agents, Jungle web is where you
// arrange them, and a second half-built management UI would just be a place for the two to
// disagree.
async function publishAppHome(install: db.SlackInstall, slackUserId: string | undefined): Promise<void> {
  if (!slackUserId) return;
  try {
    const [participants, workflows] = await Promise.all([
      db.listParticipants(install.workspace_id),
      db.listWorkspaceWorkflows(install.workspace_id),
    ]);
    const agents = participants.filter((p) => p.kind === "agent" && !p.jungle_default);
    const live = workflows.filter((w) => w.status !== "draft");
    const web = (process.env.FRONTEND_URL ?? "https://jungleagents.com").replace(/\/$/, "");

    const blocks: unknown[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Jungle*\nDM me to build an agent or a workflow. Everything here is live in <" + web + "|the Jungle app> too.",
        },
      },
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: agents.length ? `*Agents* (${agents.length})` : "*Agents*\n_None yet — DM me to make one._" },
      },
    ];
    for (const a of agents.slice(0, 20)) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*${a.display_name}* · \`@${a.handle}\`${a.persona ? `\n${truncate(a.persona, 140)}` : ""}` },
      });
    }
    if (agents.length > 20) {
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `…and ${agents.length - 20} more in <${web}|Jungle>` }] });
    }
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: live.length ? `*Workflows* (${live.length})` : "*Workflows*\n_None yet._" },
    });
    for (const w of live.slice(0, 10)) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*${w.name}*${w.status === "active" ? "" : ` · _${w.status}_`}` },
      });
    }

    await slack.viewsPublish(install.bot_token, slackUserId, blocks);
  } catch (e) {
    // App Home is decorative; never let it break the app.
    console.error("slack agent: app home publish failed", (e as Error).message);
  }
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}
