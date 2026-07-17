import { Router } from "express";
import { randomBytes } from "node:crypto";
import * as db from "../../db";
import { wrap, ApiError } from "../errors";
import { requireRequester, requireChannelMember } from "../guards";
import { verifySlackSignature } from "../../slack/verify";
import * as slack from "../../slack/api";
import * as bridge from "../../services/slackBridge";
import { popupClosePage } from "../oauthPopup";

// Slack integration HTTP surface. Two routers:
//   - slackEventsRouter: the raw-body webhook (mounted BEFORE express.json() in app.ts so the
//     signature can be verified over the exact bytes).
//   - slackRouter: the JSON routes (OAuth install, status, channel list, per-channel link CRUD).

const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID ?? "";
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET ?? "";
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? "";
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

// The bot scopes we request. channels:join is load-bearing — the Events API only delivers
// message.channels for channels the bot is a member of, and we join at link time.
const SLACK_SCOPES = [
  "channels:history",
  "channels:read",
  "channels:join",
  "chat:write",
  "chat:write.customize",
  "users:read",
  "users:read.email",
].join(",");

// Backend public origin for the OAuth redirect (same derivation as routes/integrations.ts).
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
const REDIRECT_URI = `${BACKEND_ORIGIN}/auth/slack/callback`;

// ============================ Events webhook (raw body) ============================

export const slackEventsRouter = Router();

slackEventsRouter.post("/api/slack/events", (req, res) => {
  void (async () => {
    // Buffer raw bytes (this route runs before express.json()).
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);

    // Verify the Slack signature over the raw body — unconditionally, before anything else.
    const okSig = verifySlackSignature(
      SLACK_SIGNING_SECRET,
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

    // URL verification handshake (sent when you save the Events request URL).
    if (payload.type === "url_verification") {
      res.status(200).json({ challenge: payload.challenge });
      return;
    }

    // Ack immediately (Slack's 3s rule); process asynchronously. The fire-and-forget agent
    // cascade inside processSlackEvent must run AFTER this ack.
    res.status(200).end();
    void bridge.processSlackEvent(payload).catch((e) => console.error("slack event processing:", e));
  })().catch((e) => {
    console.error("slack events route:", e);
    if (!res.headersSent) res.status(500).end();
  });
});

// ============================ JSON routes ============================

export const slackRouter = Router();

// Pending OAuth installs keyed by opaque state (in-memory, single backend — mirrors integrations.ts).
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

// Begin an install: an admin gets an authorize URL to open (popup or full-page).
slackRouter.post(
  "/api/slack/install-url",
  wrap(async (req, res) => {
    const me = await requireAdmin(req);
    if (!SLACK_CLIENT_ID) throw new ApiError(500, "Slack app not configured (SLACK_CLIENT_ID missing)");
    const state = randomBytes(16).toString("hex");
    trackInstall(state, { workspaceId: me.workspace_id, participantId: me.id, popup: req.body?.popup === true });
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", SLACK_CLIENT_ID);
    url.searchParams.set("scope", SLACK_SCOPES);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("state", state);
    res.json({ url: url.toString() });
  }),
);

// OAuth callback: exchange the code for a bot token and record the install. Unauthenticated — the
// opaque state authenticates the round-trip (same model as routes/integrations.ts).
slackRouter.get("/auth/slack/callback", async (req, res) => {
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
      clientId: SLACK_CLIENT_ID,
      clientSecret: SLACK_CLIENT_SECRET,
      code,
      redirectUri: REDIRECT_URI,
    });

    // One Slack team ↔ one Jungle workspace: reject if this team is already bound elsewhere.
    const existing = await db.getSlackInstallByTeam(oauth.team.id);
    if (existing && existing.workspace_id !== entry.workspaceId) {
      return done(
        { connection: "slack", status: "error", reason: "This Slack workspace is already connected to another Jungle workspace." },
        { integration: "slack", status: "error", reason: "slack-team-taken" },
      );
    }

    // auth.test resolves our bot_id (carried on our own posts → used for echo suppression).
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
    });
    done(
      { connection: "slack", status: "connected", account: oauth.team.name ?? undefined },
      { integration: "slack", status: "connected" },
    );
  } catch (e) {
    const reason = String((e as Error).message ?? e);
    done({ connection: "slack", status: "error", reason }, { integration: "slack", status: "error", reason });
  }
});

// Workspace install status.
slackRouter.get(
  "/api/slack/status",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    res.json(await bridge.getStatus(me.workspace_id));
  }),
);

// Disconnect the whole install (admin). FK cascade removes links + outbox.
slackRouter.delete(
  "/api/slack/install",
  wrap(async (req, res) => {
    const me = await requireAdmin(req);
    await db.deleteSlackInstall(me.workspace_id);
    res.json({ ok: true });
  }),
);

// Public Slack channels the bot can see, for the link picker (admin).
slackRouter.get(
  "/api/slack/channels",
  wrap(async (req, res) => {
    const me = await requireAdmin(req);
    res.json(await bridge.listSlackChannels(me.workspace_id));
  }),
);

// Current mirror binding for a Jungle channel (null when unlinked). Any channel member may read.
slackRouter.get(
  "/api/channels/:id/slack-link",
  wrap(async (req, res) => {
    const { channel } = await requireChannelMember(req);
    res.json({ link: await bridge.getChannelLink(channel.id) });
  }),
);

// Link a Jungle channel to a Slack channel (admin + channel member).
slackRouter.post(
  "/api/channels/:id/slack-link",
  wrap(async (req, res) => {
    const { me, channel } = await requireChannelMember(req);
    if (me.role !== "admin") throw new ApiError(403, "admin only");
    const slackChannelId = String(req.body?.slackChannelId ?? "").trim();
    if (!slackChannelId) throw new ApiError(400, "slackChannelId is required");
    const link = await bridge.linkChannel(me, channel, slackChannelId);
    res.json({ link });
  }),
);

// Unlink (admin + channel member).
slackRouter.delete(
  "/api/channels/:id/slack-link",
  wrap(async (req, res) => {
    const { me, channel } = await requireChannelMember(req);
    if (me.role !== "admin") throw new ApiError(403, "admin only");
    await bridge.unlinkChannel(channel);
    res.json({ ok: true });
  }),
);
