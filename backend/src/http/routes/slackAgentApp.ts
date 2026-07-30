import { Router } from "express";
import { randomBytes } from "node:crypto";
import * as db from "../../db";
import { wrap, ApiError } from "../errors";
import { requireRequester } from "../guards";
import { verifySlackSignature } from "../../slack/verify";
import * as slack from "../../slack/api";
import * as agentBridge from "../../services/slackAgentBridge";
import { popupClosePage } from "../oauthPopup";

// HTTP surface for the Slack AGENT app — @jungle's DM in Slack. This is a SECOND Slack app,
// separate from the channel-mirror app in routes/slack.ts, because Slack's `features.agent_view`
// is an irreversible per-app switch and we will not flip it on the live mirroring app.
//
// Deliberately a parallel file rather than a `kind` parameter threaded through routes/slack.ts:
// the two apps have different credentials, different scopes, different event subscriptions and
// different webhooks. The shared part (participant resolution, persistence, the outbox) is shared
// in the SERVICE layer, which is where sharing actually pays.
//
// Two routers, same shape as routes/slack.ts:
//   - slackAgentEventsRouter: raw-body webhook, mounted BEFORE express.json() in app.ts.
//   - slackAgentRouter: JSON routes (OAuth install, status, uninstall).

const CLIENT_ID = process.env.SLACK_AGENT_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.SLACK_AGENT_CLIENT_SECRET ?? "";
const SIGNING_SECRET = process.env.SLACK_AGENT_SIGNING_SECRET ?? "";
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

// Scopes for the agent experience. im:history + the message.im event are what make the DM work at
// all; assistant:write is the "…is thinking" status; chat:write.customize lets a reply carry the
// speaking agent's name and avatar rather than the app's.
const AGENT_SCOPES = [
  "im:history",
  "im:write",
  "chat:write",
  "chat:write.customize",
  "assistant:write",
  "users:read",
  "users:read.email",
].join(",");

const BACKEND_ORIGIN = (() => {
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
const REDIRECT_URI = `${BACKEND_ORIGIN}/auth/slack-agent/callback`;

// ============================ Events webhook (raw body) ============================

export const slackAgentEventsRouter = Router();

slackAgentEventsRouter.post("/api/slack/agent-events", (req, res) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);

    // Verify against the AGENT app's signing secret — a different app, a different secret. Doing
    // this unconditionally and first is what stops anyone posting events as us.
    const okSig = verifySlackSignature(
      SIGNING_SECRET,
      raw,
      req.header("x-slack-request-timestamp"),
      req.header("x-slack-signature"),
    );
    if (!okSig) {
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

    if (payload.type === "url_verification") {
      res.status(200).json({ challenge: payload.challenge });
      return;
    }

    // Ack within Slack's 3s rule; the turn it kicks off takes far longer than that.
    res.status(200).end();
    void agentBridge
      .processAgentAppEvent(payload)
      .catch((e) => console.error("slack agent event processing:", e));
  })().catch((e) => {
    console.error("slack agent events route:", e);
    if (!res.headersSent) res.status(500).end();
  });
});

// ============================ JSON routes ============================

export const slackAgentRouter = Router();

interface PendingInstall {
  workspaceId: string;
  participantId: string;
  popup: boolean;
  createdAt: number;
}
const pendingInstalls = new Map<string, PendingInstall>();
const STATE_TTL_MS = 15 * 60 * 1000;
function trackInstall(state: string, entry: Omit<PendingInstall, "createdAt">): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, v] of pendingInstalls) if (v.createdAt < cutoff) pendingInstalls.delete(k);
  pendingInstalls.set(state, { ...entry, createdAt: Date.now() });
}

async function requireAdmin(req: import("express").Request): Promise<db.Participant> {
  const me = await requireRequester(req);
  if (me.role !== "admin") throw new ApiError(403, "admin only");
  return me;
}

slackAgentRouter.post(
  "/api/slack/agent/install-url",
  wrap(async (req, res) => {
    const me = await requireAdmin(req);
    if (!CLIENT_ID) throw new ApiError(500, "Slack agent app not configured (SLACK_AGENT_CLIENT_ID missing)");
    const state = randomBytes(16).toString("hex");
    trackInstall(state, { workspaceId: me.workspace_id, participantId: me.id, popup: req.body?.popup === true });
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("scope", AGENT_SCOPES);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("state", state);
    res.json({ url: url.toString() });
  }),
);

slackAgentRouter.get("/auth/slack-agent/callback", async (req, res) => {
  const code = (req.query.code as string | undefined) || "";
  const state = (req.query.state as string | undefined) || "";
  const entry = state ? pendingInstalls.get(state) : undefined;
  const done = (result: Parameters<typeof popupClosePage>[0], settingsParams: Record<string, string>) => {
    if (entry?.popup) return res.send(popupClosePage(result));
    res.redirect(`${FRONTEND_URL}/settings?${new URLSearchParams(settingsParams).toString()}`);
  };
  try {
    if (!code || !entry) return res.status(400).send("invalid or expired OAuth state");
    pendingInstalls.delete(state);

    const oauth = await slack.oauthV2Access({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      code,
      redirectUri: REDIRECT_URI,
    });

    // One Slack team ↔ one Jungle workspace, same rule as the mirror app (and enforced per-kind by
    // slack_installs_team_kind_idx). The two apps may point at the same team; two WORKSPACES may
    // not point at the same team.
    const existing = await db.getSlackInstallByTeam(oauth.team.id, "agent");
    if (existing && existing.workspace_id !== entry.workspaceId) {
      return done(
        { connection: "slack-agent", status: "error", reason: "This Slack workspace is already connected to another Jungle workspace." },
        { integration: "slack-agent", status: "error", reason: "slack-team-taken" },
      );
    }

    const authInfo = await slack.authTest(oauth.access_token);
    await db.upsertSlackInstall({
      workspaceId: entry.workspaceId,
      teamId: oauth.team.id,
      teamName: oauth.team.name ?? null,
      botToken: oauth.access_token,
      botUserId: oauth.bot_user_id,
      botId: authInfo.bot_id ?? null,
      scopes: oauth.scope,
      installedBy: entry.participantId,
      kind: "agent",
    });

    return done(
      { connection: "slack-agent", status: "connected", account: oauth.team.name ?? oauth.team.id },
      { integration: "slack-agent", status: "connected" },
    );
  } catch (e) {
    console.error("slack agent oauth callback:", e);
    return done(
      { connection: "slack-agent", status: "error", reason: (e as Error).message },
      { integration: "slack-agent", status: "error", reason: "oauth-failed" },
    );
  }
});

slackAgentRouter.get(
  "/api/slack/agent/status",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const install = await db.getSlackInstallByWorkspace(me.workspace_id, "agent");
    res.json(
      install
        ? { installed: true, teamName: install.team_name, status: install.status }
        : { installed: false },
    );
  }),
);

slackAgentRouter.delete(
  "/api/slack/agent/install",
  wrap(async (req, res) => {
    const me = await requireAdmin(req);
    // Cascades to this app's DM links (slack_channel_links_install_fkey); the Jungle DM channels
    // and their history are untouched — uninstalling a surface must never delete the conversation.
    await db.deleteSlackInstall(me.workspace_id, "agent");
    res.status(204).end();
  }),
);
