import { Router, type Request } from "express";
import { MODEL_CATALOG } from "@jungle/shared";
import * as db from "../../db";
import * as slack from "../../slack/api";
import { verifySlackSignature } from "../../slack/verify";
import { providerConfigured } from "../../providers";
import * as liana from "../../services/liana";
import * as imsg from "../../services/imessage";
import * as tg from "../../services/telegram";
import * as workflows from "../../services/workflows";
import { ApiError } from "../errors";

// Liana's HTTP surface. Two routers:
//  - lianaEventsRouter: the Liana Slack app's webhooks (events + interactivity). Signed over the
//    RAW body with Liana's own signing secret, so this mounts BEFORE express.json() — exactly
//    like slackEventsRouter.
//  - lianaRouter: JSON routes — the public install flow (/auth/liana/slack/*) and the token-authed
//    REST API the Liana web app consumes (/api/liana/*). Auth is a signed bearer token minted by
//    the Slack bot ("Open in Liana" links), NOT the jungle Firebase session.

const CLIENT_ID = process.env.LIANA_SLACK_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.LIANA_SLACK_CLIENT_SECRET ?? "";
const SIGNING_SECRET = process.env.LIANA_SLACK_SIGNING_SECRET ?? "";

export const BACKEND_ORIGIN = (() => {
  if (process.env.BACKEND_PUBLIC_URL) return process.env.BACKEND_PUBLIC_URL.replace(/\/$/, "");
  const g = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (g) {
    try {
      return new URL(g).origin;
    } catch {
      /* fall through */
    }
  }
  return "http://localhost:3001";
})();
const REDIRECT_URI = `${BACKEND_ORIGIN}/auth/liana/slack/callback`;

// Bot scopes: mentions + DMs + posting; users:read.email for identity auto-linking; the
// channels:* trio matches the mirroring app so a future channel feature needs no reinstall.
const SCOPES = [
  "app_mentions:read",
  "chat:write",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
  "users:read.email",
  "channels:history",
  "channels:read",
  "channels:join",
].join(",");

// ============================ Webhooks (raw body) ============================

export const lianaEventsRouter = Router();

async function readRaw(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

lianaEventsRouter.post("/api/liana/slack/events", (req, res) => {
  void (async () => {
    const raw = await readRaw(req);
    if (!verifySlackSignature(SIGNING_SECRET, raw, req.header("x-slack-request-timestamp"), req.header("x-slack-signature"))) {
      res.status(401).send("bad signature");
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      res.status(400).send("bad json");
      return;
    }
    // URL verification handshake (sent when the app manifest is saved).
    if (payload.type === "url_verification") {
      res.status(200).json({ challenge: payload.challenge });
      return;
    }
    // Ack fast (3s rule), process async.
    res.status(200).end();
    void liana.processLianaEvent(payload).catch((e) => console.error("liana event processing:", e));
  })().catch((e) => {
    console.error("liana events route:", e);
    if (!res.headersSent) res.status(500).end();
  });
});

// Interactivity: form-encoded `payload=<json>`, signed over the raw form body.
lianaEventsRouter.post("/api/liana/slack/interactivity", (req, res) => {
  void (async () => {
    const raw = await readRaw(req);
    if (!verifySlackSignature(SIGNING_SECRET, raw, req.header("x-slack-request-timestamp"), req.header("x-slack-signature"))) {
      res.status(401).send("bad signature");
      return;
    }
    const params = new URLSearchParams(raw.toString("utf8"));
    const payloadStr = params.get("payload");
    if (!payloadStr) {
      res.status(400).send("no payload");
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      res.status(400).send("bad payload json");
      return;
    }
    res.status(200).end();
    void liana.handleInteractivity(payload).catch((e) => console.error("liana interactivity:", e));
  })().catch((e) => {
    console.error("liana interactivity route:", e);
    if (!res.headersSent) res.status(500).end();
  });
});

// Inbound iMessage (Linq) webhook. Standard Webhooks signature over the RAW body; at-least-once
// delivery, so dedupe by webhook id (shared events table, "linq:" prefixed).
lianaEventsRouter.post("/api/liana/imessage/webhook", (req, res) => {
  void (async () => {
    const raw = await readRaw(req);
    const ok = imsg.verifyLinqWebhook(raw, {
      id: req.header("webhook-id"),
      timestamp: req.header("webhook-timestamp"),
      signature: req.header("webhook-signature"),
    });
    if (!ok) {
      res.status(401).send("bad signature");
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      res.status(400).send("bad json");
      return;
    }
    res.status(200).end(); // ack fast; Linq retries on non-2xx
    const eventId = req.header("webhook-id")!;
    if (!(await db.recordSlackEvent(`linq:${eventId}`))) return; // duplicate delivery
    const inbound = imsg.parseInboundEvent(payload, eventId);
    if (inbound) {
      void liana.processIMessageInbound(inbound).catch((e) => console.error("liana imessage processing:", e));
    }
  })().catch((e) => {
    console.error("liana imessage webhook route:", e);
    if (!res.headersSent) res.status(500).end();
  });
});

// Inbound Telegram webhook. Auth = the secret_token we registered via setWebhook, echoed back
// by Telegram in a header on every update. At-least-once delivery; dedupe by update_id
// (shared events table, "tg:" prefixed).
lianaEventsRouter.post("/api/liana/telegram/webhook", (req, res) => {
  void (async () => {
    if (!tg.verifyTelegramWebhook(req.header("x-telegram-bot-api-secret-token"))) {
      res.status(401).send("bad secret");
      return;
    }
    const raw = await readRaw(req);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      res.status(400).send("bad json");
      return;
    }
    res.status(200).end(); // ack fast; Telegram retries on non-2xx
    const inbound = tg.parseUpdate(payload);
    if (!inbound) return;
    if (!(await db.recordSlackEvent(`tg:${inbound.updateId}`))) return; // duplicate delivery
    void liana.processTelegramInbound(inbound).catch((e) => console.error("liana telegram processing:", e));
  })().catch((e) => {
    console.error("liana telegram webhook route:", e);
    if (!res.headersSent) res.status(500).end();
  });
});

// ============================ JSON routes ============================

export const lianaRouter = Router();

// --- Install flow (public — "Add to Slack") ---

lianaRouter.get("/auth/liana/slack/install", (req, res) => {
  if (!CLIENT_ID) {
    res.status(500).send("Liana Slack app not configured");
    return;
  }
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("state", liana.newInstallState());
  res.redirect(url.toString());
});

lianaRouter.get("/auth/liana/slack/callback", async (req, res) => {
  const code = String(req.query.code ?? "");
  const state = String(req.query.state ?? "");
  if (!code || !liana.consumeInstallState(state)) {
    res.status(400).send("Install session expired — start again from the install link.");
    return;
  }
  try {
    const oauth = await slack.oauthV2Access({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      code,
      redirectUri: REDIRECT_URI,
    });
    const install = await liana.handleInstallCallback(oauth);
    res
      .status(200)
      .type("html")
      .send(
        `<!doctype html><meta charset="utf-8"><title>Liana installed</title>` +
          `<body style="font-family:system-ui;max-width:32rem;margin:15vh auto;line-height:1.6">` +
          `<h1 style="font-weight:600">🌿 Liana is in ${escapeHtml(install.team_name ?? "your workspace")}</h1>` +
          `<p>Head back to Slack and message <b>@Liana</b> — try:</p>` +
          `<p style="background:#f4f1ea;padding:12px 16px;border-radius:8px">Give me a morning briefing every day at 8am</p>`,
      );
  } catch (e) {
    console.error("liana install callback:", e);
    res.status(500).send("Install failed — check the backend logs.");
  }
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// --- Web-app REST API (bearer token minted by the bot) ---

interface LianaAuth {
  teamId: string;
  slackUserId: string;
  me: db.Participant;
  install: db.LianaInstall;
}

async function requireLianaAuth(req: Request): Promise<LianaAuth> {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = token ? liana.verifyLianaToken(token) : null;
  if (!payload) throw new ApiError(401, "invalid or expired token — reopen Liana from Slack");
  const [me, install] = await Promise.all([db.getParticipant(payload.p), db.getLianaInstall(payload.t)]);
  if (!me || !install || install.status !== "active") throw new ApiError(401, "account not found");
  return { teamId: payload.t, slackUserId: payload.u, me, install };
}

// A workflow owned by the caller, or 404 (ownership check doubles as the authz check).
async function requireOwnedWorkflow(
  auth: LianaAuth,
  workflowId: string,
): Promise<{ wf: db.WorkflowRow; row: db.LianaWorkflowRow }> {
  const row = await db.getLianaWorkflow(workflowId);
  if (!row || row.team_id !== auth.teamId || row.owner_participant_id !== auth.me.id) {
    throw new ApiError(404, "workflow not found");
  }
  const wf = await db.getWorkflow(workflowId);
  if (!wf) throw new ApiError(404, "workflow not found");
  return { wf, row };
}

async function wireWorkflow(wf: db.WorkflowRow): Promise<Record<string, unknown>> {
  const schedule = await db.getWorkflowBackingSchedule(wf.id);
  const runs = await db.listWorkflowRuns(wf.id, 1);
  const integrations = wf.roster[0]?.integrations ?? [];
  const lianaRow = await db.getLianaWorkflow(wf.id);
  return {
    id: wf.id,
    name: wf.name,
    status: wf.status,
    prompt: liana.promptOf(wf),
    trigger: wf.trigger,
    cadence: liana.cadenceSentence(wf),
    integrations,
    model: await liana.workflowModel(wf),
    deliverTo: lianaRow?.deliver_to?.length ? lianaRow.deliver_to : ["slack"],
    nextRunAt: schedule?.next_run_at ?? null,
    lastRun: runs[0]
      ? { id: runs[0].id, status: runs[0].status, startedAt: runs[0].started_at, endedAt: runs[0].ended_at, summary: runs[0].summary }
      : null,
  };
}

lianaRouter.get("/api/liana/me", async (req, res) => {
  const auth = await requireLianaAuth(req);
  res.json({
    displayName: auth.me.display_name,
    teamName: auth.install.team_name,
  });
});

lianaRouter.get("/api/liana/workflows", async (req, res) => {
  const auth = await requireLianaAuth(req);
  const rows = await db.listLianaWorkflowsForOwner(auth.teamId, auth.slackUserId);
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const wf = await db.getWorkflow(row.workflow_id);
    if (wf) out.push(await wireWorkflow(wf));
  }
  res.json({ workflows: out });
});

lianaRouter.get("/api/liana/workflows/:id", async (req, res) => {
  const auth = await requireLianaAuth(req);
  const { wf } = await requireOwnedWorkflow(auth, req.params.id);
  const runs = await db.listWorkflowRuns(wf.id, 30);
  res.json({
    workflow: await wireWorkflow(wf),
    runs: runs.map((r) => ({ id: r.id, status: r.status, trigger: r.trigger, startedAt: r.started_at, endedAt: r.ended_at, summary: r.summary })),
  });
});

lianaRouter.get("/api/liana/workflows/:id/runs/:runId", async (req, res) => {
  const auth = await requireLianaAuth(req);
  const { wf } = await requireOwnedWorkflow(auth, req.params.id);
  const run = await db.getWorkflowRun(req.params.runId);
  if (!run || run.workflow_id !== wf.id) throw new ApiError(404, "run not found");
  res.json({
    run: { id: run.id, status: run.status, trigger: run.trigger, startedAt: run.started_at, endedAt: run.ended_at, summary: run.summary },
    output: await liana.runDeliverableText(run, wf),
  });
});

lianaRouter.patch("/api/liana/workflows/:id", async (req, res) => {
  const auth = await requireLianaAuth(req);
  const { wf } = await requireOwnedWorkflow(auth, req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.model === "string") await liana.setLianaWorkflowModel(wf, body.model);
  const updated = await liana.editLianaWorkflow(wf, auth.me, {
    name: typeof body.name === "string" ? body.name : undefined,
    prompt: typeof body.prompt === "string" ? body.prompt : undefined,
    cron: body.cron === null ? null : typeof body.cron === "string" ? body.cron : undefined,
    timezone: typeof body.timezone === "string" ? body.timezone : undefined,
    paused: typeof body.paused === "boolean" ? body.paused : undefined,
    deliverTo: Array.isArray(body.deliverTo) ? body.deliverTo.map(String) : undefined,
    integrations: Array.isArray(body.integrations) ? body.integrations.map(String) : undefined,
  });
  res.json({ workflow: await wireWorkflow(updated) });
});

lianaRouter.post("/api/liana/workflows/:id/run", async (req, res) => {
  const auth = await requireLianaAuth(req);
  const { wf } = await requireOwnedWorkflow(auth, req.params.id);
  const run = await workflows.startRun(wf, "manual");
  res.json({ run: { id: run.id, status: run.status, startedAt: run.started_at } });
});

lianaRouter.delete("/api/liana/workflows/:id", async (req, res) => {
  const auth = await requireLianaAuth(req);
  const { wf } = await requireOwnedWorkflow(auth, req.params.id);
  if (wf.status === "draft") await workflows.cleanupDraftAgents(wf);
  await db.deleteWorkflow(wf.id);
  res.json({ ok: true });
});

// --- Channels (Settings): Slack is implicit; iMessage links a phone via texted code ---

lianaRouter.get("/api/liana/channels", async (req, res) => {
  const auth = await requireLianaAuth(req);
  res.json({ channels: await liana.channelStatus(auth.me, auth.install) });
});

lianaRouter.post("/api/liana/channels/imessage", async (req, res) => {
  const auth = await requireLianaAuth(req);
  const phone = String((req.body as Record<string, unknown>)?.phone ?? "");
  await liana.startPhoneVerify(auth.me, phone);
  res.json({ ok: true });
});

lianaRouter.post("/api/liana/channels/imessage/verify", async (req, res) => {
  const auth = await requireLianaAuth(req);
  const code = String((req.body as Record<string, unknown>)?.code ?? "");
  const link = await liana.confirmPhoneVerify(auth.me, code);
  res.json({ phone: link.phone, verified: true });
});

lianaRouter.delete("/api/liana/channels/imessage", async (req, res) => {
  const auth = await requireLianaAuth(req);
  await db.deletePhoneLink(auth.me.id);
  res.json({ ok: true });
});

// Telegram links via a t.me deep link: this mints the code and returns the URL; the bot's
// /start handler completes the bind, and the web app polls GET /channels to see it land.
lianaRouter.post("/api/liana/channels/telegram/start", async (req, res) => {
  const auth = await requireLianaAuth(req);
  res.json({ url: await liana.startTelegramLink(auth.me) });
});

lianaRouter.delete("/api/liana/channels/telegram", async (req, res) => {
  const auth = await requireLianaAuth(req);
  await db.deleteTelegramLink(auth.me.id);
  res.json({ ok: true });
});

// The model picker's option list: the shared catalog, minus models whose provider key isn't
// configured on this deployment (they'd 400 on selection anyway).
lianaRouter.get("/api/liana/models", async (req, res) => {
  await requireLianaAuth(req);
  res.json({
    models: MODEL_CATALOG.filter((m) => providerConfigured(m.id)).map((m) => ({
      id: m.id,
      label: m.label,
      hint: m.hint,
    })),
    defaults: { liana: liana.DEFAULT_LIANA_MODEL, workflow: liana.DEFAULT_WORKFLOW_MODEL },
  });
});

lianaRouter.get("/api/liana/settings", async (req, res) => {
  const auth = await requireLianaAuth(req);
  const s = await db.getLianaSettings(auth.me.id);
  res.json({ lianaModel: s?.liana_model ?? null, workflowModel: s?.workflow_model ?? null });
});

// Partial update; null resets a knob to the built-in default. Validated against the catalog.
lianaRouter.put("/api/liana/settings", async (req, res) => {
  const auth = await requireLianaAuth(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const check = (v: unknown, field: string): string | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const m = String(v);
    if (!MODEL_CATALOG.some((e) => e.id === m)) throw new ApiError(400, `unsupported ${field}: ${m}`);
    if (!providerConfigured(m)) throw new ApiError(400, `model unavailable: ${m}'s provider key is not configured`);
    return m;
  };
  const s = await db.upsertLianaSettings(auth.me.id, {
    lianaModel: check(body.lianaModel, "lianaModel"),
    workflowModel: check(body.workflowModel, "workflowModel"),
  });
  res.json({ lianaModel: s.liana_model, workflowModel: s.workflow_model });
});

lianaRouter.get("/api/liana/connections", async (req, res) => {
  const auth = await requireLianaAuth(req);
  const keys = ["gmail", "google-calendar", "google-drive", "github", "x", "linear", "notion", "granola", "posthog", "mixpanel"];
  res.json({ connections: await liana.connectionStatus(auth.me, keys) });
});


// Begin an OAuth connect for the token-authed Liana user. Returns an authorize URL the web app
// opens in a popup; the callback lands on the shared backend handlers (routes/google.ts,
// routes/github.ts, routes/integrations.ts), which post a self-closing page — origin-agnostic,
// so the Liana origin works. Google-backed keys share one grant; x/linear/notion/granola go
// through the integration adapters' own start flows.
lianaRouter.post("/api/liana/connections/:key/start", async (req, res) => {
  const auth = await requireLianaAuth(req);
  const key = req.params.key;
  let url: string | null;
  if (key === "gmail" || key === "google") {
    // Gmail rides the shared Google identity grant; calendar/drive do NOT — their adapters run
    // their own OAuth (calendar/drive scopes → integration_connections), so they fall through
    // to beginIntegrationConnect below. Sending them here would mint a scopeless-for-them
    // identity grant that the attach path can't use.
    const { beginGoogleConnect } = await import("./google");
    url = beginGoogleConnect(auth.me.id, true);
  } else if (key === "github") {
    const { beginGithubConnect } = await import("./github");
    url = beginGithubConnect(auth.me.id, true);
  } else {
    const { beginIntegrationConnect } = await import("./integrations");
    url = await beginIntegrationConnect(auth.me, key, true); // throws 400 on unknown keys
  }
  if (!url) throw new ApiError(500, "provider not configured");
  res.json({ url });
});
