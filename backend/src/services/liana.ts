import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isAllowedModel, type WorkflowRole } from "@jungle/shared";
import * as db from "../db";
import * as slack from "../slack/api";
import * as runners from "../runners";
import { providerConfigured } from "../providers";
import { jungleToSlackText } from "../slack/format";
import { ApiError } from "../http/errors";
import * as workflows from "./workflows";
import { uniqueHandle } from "./slackBridge";
import { computeNextRun, isValidTimeZone } from "./scheduler";
import { runIntake, type IntakeWorkflowSpec } from "./lianaIntake";

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

// Kimi K3 is Liana's built-in default for both knobs: the intake model (what Liana herself
// thinks with) and the model new workflows start on. Users override either in Settings; each
// workflow's agent carries its own concrete model after creation.
export const DEFAULT_LIANA_MODEL = "kimi-k3";
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

// ============================ Owner resolution ============================

// Slack user -> participant in the install's workspace. Shares slack_user_links with the
// mirroring bridge so one person is one participant; creates a shadow human on first contact.
async function getOrCreateOwner(
  install: db.LianaInstall,
  slackUserId: string,
): Promise<{ participant: db.Participant; profile: slack.SlackUserProfile | null }> {
  let profile: slack.SlackUserProfile | null = null;
  try {
    profile = await slack.usersInfo(install.bot_token, slackUserId);
  } catch (e) {
    console.error("liana: users.info failed", slackUserId, e);
  }

  const existing = await db.getUserLink(install.team_id, slackUserId);
  if (existing) {
    const p = await db.getParticipant(existing.participant_id);
    if (p) return { participant: p, profile };
  }
  if (!profile) throw new Error("liana: cannot resolve Slack user profile");

  if (profile.email) {
    const human = await db.getParticipantByEmail(install.workspace_id, profile.email);
    if (human) {
      await db.insertUserLink({ teamId: install.team_id, slackUserId, participantId: human.id, kind: "linked" });
      return { participant: human, profile };
    }
  }

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
  return { participant: shadow, profile };
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

  try {
    const { participant: owner, profile } = await getOrCreateOwner(install, ev.user);
    const text = stripBotMention(ev.text ?? "", install.bot_user_id).trim();
    if (!text) {
      await postReply(install, reply, `Hi! Tell me what you'd like automated — e.g. "give me a morning briefing every day at 8am".`);
      return;
    }

    const existing = await describeOwnerWorkflows(install.team_id, ev.user);
    const intake = await runIntake(
      text,
      {
        userName: profile?.displayName ?? owner.display_name,
        userTz: profile?.tz ?? null,
        today: new Intl.DateTimeFormat("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date()),
        existingWorkflows: existing.map((w) => w.line),
      },
      await intakeModelFor(owner.id),
    );

    if (intake.intent === "list_workflows") {
      await postWorkflowList(install, reply, owner, existing);
      return;
    }
    if (intake.intent === "create_workflow" && intake.workflow) {
      await createDraftAndPostCard(install, owner, ev.user, intake.workflow, profile, reply, intake.reply);
      return;
    }
    await postReply(install, reply, intake.reply);
  } catch (e) {
    console.error("liana event:", e);
    try {
      await postReply(install, reply, "Something went wrong on my end — mind trying that again?");
    } catch {
      /* ignore */
    }
  }
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

// ============================ Workflow list ============================

interface OwnedWorkflow {
  wf: db.WorkflowRow;
  liana: db.LianaWorkflowRow;
  line: string;
}

async function describeOwnerWorkflows(teamId: string, slackUserId: string): Promise<OwnedWorkflow[]> {
  const rows = await db.listLianaWorkflowsForOwner(teamId, slackUserId);
  const out: OwnedWorkflow[] = [];
  for (const liana of rows) {
    const wf = await db.getWorkflow(liana.workflow_id);
    if (!wf) continue;
    out.push({ wf, liana, line: `${wf.name} (${cadenceSentence(wf)}${wf.status === "paused" ? ", paused" : wf.status === "draft" ? ", draft" : ""})` });
  }
  return out;
}

// "every day at 8:00 AM" — a human sentence for the common cron shapes, cron text otherwise.
export function cadenceSentence(wf: Pick<db.WorkflowRow, "trigger">): string {
  const t = wf.trigger;
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

async function postWorkflowList(
  install: db.LianaInstall,
  reply: { channel: string; threadTs: string | null },
  owner: db.Participant,
  existing: OwnedWorkflow[],
): Promise<void> {
  if (!existing.length) {
    await postReply(install, reply, `You don't have any workflows yet. Try: "give me a morning briefing every day at 8am".`);
    return;
  }
  const lines = existing.map((w) => `• *${w.wf.name}* — ${cadenceSentence(w.wf)}${w.wf.status === "paused" ? " (paused)" : ""}`);
  const url = await webLink(install.team_id, owner);
  await postReply(install, reply, `Your workflows:\n${lines.join("\n")}`, [
    { type: "section", text: { type: "mrkdwn", text: `Your workflows:\n${lines.join("\n")}` } },
    {
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "Open in Liana" }, url }],
    },
  ]);
}

// ============================ Draft creation + confirm card ============================

const DEFAULT_TZ = "America/Los_Angeles";

function buildPlaybook(prompt: string): string {
  return (
    `${prompt.trim()}\n\n— How to run —\n` +
    `You are the only member of this workflow: do the work yourself, don't wait on anyone. ` +
    `Post the finished deliverable as ONE thread message in clean markdown — it is delivered to ` +
    `the user word-for-word, so write it ready to read (no preamble about what you did). Then post ` +
    `a separate short message "Run complete: <one-line summary>". If there is genuinely nothing ` +
    `to report this run, skip the deliverable and just post "Run complete: nothing to report."`
  );
}

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return s || "workflow";
}

export async function createLianaDraft(args: {
  install: db.LianaInstall;
  owner: db.Participant;
  slackUserId: string;
  spec: IntakeWorkflowSpec;
  defaultTz: string | null;
  origin?: { channel: string; threadTs: string | null };
}): Promise<{ wf: db.WorkflowRow; liana: db.LianaWorkflowRow }> {
  const { install, owner, spec } = args;

  // Cadence: bad cron/timezone from intake degrades to on-demand rather than failing the flow.
  let trigger: db.WorkflowRow["trigger"] = { type: "manual" };
  if (spec.cron) {
    const tz = spec.timezone && isValidTimeZone(spec.timezone) ? spec.timezone : (args.defaultTz ?? DEFAULT_TZ);
    try {
      computeNextRun(spec.cron, tz);
      trigger = { type: "schedule", cron: spec.cron, timezone: tz };
    } catch {
      console.error(`liana: intake produced invalid cron ${JSON.stringify(spec.cron)}; falling back to manual`);
    }
  }

  const roster: WorkflowRole[] = [
    {
      role: "operator",
      handle_seed: slugify(spec.name),
      duties: "",
      integrations: spec.integrations,
      ...(spec.repo && spec.integrations.includes("github") ? { repo: spec.repo } : {}),
    },
  ];

  let wf = await workflows.createDraft({
    workspaceId: install.workspace_id,
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
    teamId: install.team_id,
    slackUserId: args.slackUserId,
    ownerParticipantId: owner.id,
    originChannelId: args.origin?.channel ?? null,
    originThreadTs: args.origin?.threadTs ?? null,
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
    if (key === "gmail" || key === "google-calendar" || key === "google-drive") {
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

const KEY_LABELS: Record<string, string> = {
  gmail: "Gmail",
  "google-calendar": "Google Calendar",
  "google-drive": "Google Drive",
  github: "GitHub",
  x: "X (Twitter)",
  linear: "Linear",
  notion: "Notion",
  granola: "Granola",
};

async function createDraftAndPostCard(
  install: db.LianaInstall,
  owner: db.Participant,
  slackUserId: string,
  spec: IntakeWorkflowSpec,
  profile: slack.SlackUserProfile | null,
  reply: { channel: string; threadTs: string | null },
  replySentence: string,
): Promise<void> {
  const { wf } = await createLianaDraft({
    install,
    owner,
    slackUserId,
    spec,
    defaultTz: profile?.tz ?? null,
    origin: { channel: reply.channel, threadTs: reply.threadTs },
  });

  const statuses = await connectionStatus(owner, spec.integrations);
  const integrationLines = statuses.map((s) =>
    s.connected
      ? `:white_check_mark: ${KEY_LABELS[s.key] ?? s.key}${s.account ? ` — ${s.account}` : ""}`
      : `:link: ${KEY_LABELS[s.key] ?? s.key} — connect in the web app after creating`,
  );
  const url = await webLink(install.team_id, owner);

  const detail =
    `*${wf.name}* — ${cadenceSentence(wf)}\n` +
    (integrationLines.length ? integrationLines.join("\n") : "_No integrations needed_");

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

  try {
    if (action.action_id === "liana_confirm") {
      const result = await confirmLianaWorkflow(workflowId);
      await respondViaUrl(responseUrl, {
        replace_original: true,
        text:
          `:seedling: *${result.wf.name}* is live — ${cadenceSentence(result.wf)}. ` +
          `I'm doing a first run now so you can see what it looks like; it'll land in your DMs.` +
          (result.unconnected.length
            ? `\n:link: Heads up: connect ${result.unconnected.map((k) => KEY_LABELS[k] ?? k).join(", ")} in <${result.url}|the web app> so I can use ${result.unconnected.length > 1 ? "them" : "it"}.`
            : ""),
      });
    } else if (action.action_id === "liana_cancel") {
      await cancelLianaDraft(workflowId);
      await respondViaUrl(responseUrl, { replace_original: true, text: "No problem — canceled." });
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

  // Instant first run: never make someone wait until 8am for their first payoff.
  try {
    await workflows.startRun(finalized, "manual");
  } catch (e) {
    console.error(`liana: first run of ${workflowId} failed to start:`, e);
  }

  const statuses = await connectionStatus(owner, finalized.roster[0]?.integrations ?? []);
  return {
    wf: finalized,
    unconnected: statuses.filter((s) => !s.connected).map((s) => s.key),
    url: await webLink(liana.team_id, owner),
  };
}

export async function cancelLianaDraft(workflowId: string): Promise<void> {
  const wf = await db.getWorkflow(workflowId);
  if (!wf) return;
  if (wf.status !== "draft") throw new ApiError(400, "workflow is already live — manage it in the web app");
  await workflows.cleanupDraftAgents(wf);
  await db.deleteWorkflow(wf.id);
}

// ============================ Run delivery (workflows.ts hooks in here on run close) ============================

const RUN_COMPLETE_RE = /^(?:✅\s*)?run\s+complete\b/i;

export async function onRunClosed(runId: string): Promise<void> {
  const run = await db.getWorkflowRun(runId);
  if (!run) return;
  const liana = await db.getLianaWorkflow(run.workflow_id);
  if (!liana) return; // not a Liana workflow — nothing to deliver
  const install = await db.getLianaInstall(liana.team_id);
  if (!install || install.status !== "active") return;
  const wf = await db.getWorkflow(run.workflow_id);
  if (!wf) return;

  if (!(await db.claimLianaDelivery(run.id))) return; // already delivered

  try {
    // DM channel, opened lazily on first delivery.
    let dm = liana.dm_channel_id;
    if (!dm) {
      dm = (await slack.conversationsOpen(install.bot_token, liana.slack_user_id)).id;
      await db.setLianaDmChannel(liana.workflow_id, dm);
    }

    const owner = await db.getParticipant(liana.owner_participant_id);
    const url = owner ? await webLink(liana.team_id, owner) : LIANA_WEB_URL;
    const date = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(new Date());

    let body: string;
    if (run.status === "done") {
      const deliverable = await collectDeliverable(run, wf);
      body = `*${wf.name}* · ${date}\n\n${deliverable}`;
    } else {
      body = `*${wf.name}* · ${date}\n\n:warning: This run didn't finish cleanly (${run.status}). You can check it or run it again in <${url}|Liana>.`;
    }

    const MAX = 11000; // Slack chat.postMessage text limit is 40k; keep DMs readable
    if (body.length > MAX) body = body.slice(0, MAX) + `\n\n_…truncated — <${url}|read the full run in Liana>_`;

    await slack.chatPostMessage(install.bot_token, {
      channel: dm,
      text: jungleToSlackText(body),
    });
  } catch (e) {
    console.error(`liana: delivery for run ${runId} failed:`, e);
    await db.markLianaDeliveryFailed(runId, e instanceof Error ? e.message : String(e)).catch(() => {});
  }
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

// Web PATCH: name / prompt / cadence / paused. Cadence edits keep the backing schedule row in
// sync (the ticker reads cron+next_run_at straight off it).
export async function editLianaWorkflow(
  wf: db.WorkflowRow,
  owner: db.Participant,
  args: {
    name?: string;
    prompt?: string;
    cron?: string | null; // null = switch to on-demand
    timezone?: string;
    paused?: boolean;
  },
): Promise<db.WorkflowRow> {
  const patch: Parameters<typeof db.updateWorkflow>[1] = {};
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
    }
  }

  let updated = Object.keys(patch).length ? ((await db.updateWorkflow(wf.id, patch)) ?? wf) : wf;
  if (args.paused !== undefined && updated.status !== "draft") {
    updated = await workflows.setWorkflowPaused(updated, args.paused);
  }
  return updated;
}

// ============================ Web-app link tokens ============================

// Signed bearer tokens for the Liana web app: payload.b64url + "." + hmac.b64url. Carried in
// "Open in Liana" links and then used as the Authorization: Bearer credential by the web app.
// Secret: LIANA_LINK_SECRET, falling back to the Slack signing secret (present whenever the
// Liana app is configured at all).

interface LianaTokenPayload {
  t: string; // team id
  u: string; // slack user id
  p: string; // participant id
  exp: number; // unix seconds
}

function tokenSecret(): string {
  const s = process.env.LIANA_LINK_SECRET || process.env.LIANA_SLACK_SIGNING_SECRET || "";
  if (!s) throw new Error("LIANA_LINK_SECRET / LIANA_SLACK_SIGNING_SECRET not set");
  return s;
}

export function signLianaToken(p: { teamId: string; slackUserId: string; participantId: string }, ttlDays = 30): string {
  const payload: LianaTokenPayload = {
    t: p.teamId,
    u: p.slackUserId,
    p: p.participantId,
    exp: Math.floor(Date.now() / 1000) + ttlDays * 86400,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", tokenSecret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyLianaToken(token: string): LianaTokenPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", tokenSecret()).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as LianaTokenPayload;
    if (!payload.t || !payload.u || !payload.p) return null;
    if (payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

async function webLink(teamId: string, owner: db.Participant): Promise<string> {
  // Owner links carry a fresh token; the web app stores it and uses it as its session.
  const slackUserId = (await db.getSlackUserIdForParticipant(teamId, owner.id)) ?? "";
  const token = signLianaToken({ teamId, slackUserId, participantId: owner.id });
  return `${LIANA_WEB_URL}/?t=${encodeURIComponent(token)}`;
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
