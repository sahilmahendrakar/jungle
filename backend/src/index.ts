import "./env";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import { imageSize } from "image-size";
import * as db from "./db";
import * as gh from "./github";
import * as auth from "./auth";
import * as runners from "./runners";
import * as att from "./attachments";
import { storage } from "./storage";
import { provisioner } from "./provisioner";

// Safety net: this backend is a shared relay for every user, so a stray rejection from one
// agent turn (e.g. a wedged session's "waiting on responses" 400) must not terminate the
// process. Log and keep serving instead of the Node default (crash on unhandled rejection).
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

// Where the SPA is served — GitHub OAuth callback redirects back here after connecting.
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

const app = express();
app.use(express.json());
app.use(auth.attachAuth); // populates req.auth when a valid Firebase token is present

// MVP CORS: the frontend (a different origin in dev) needs to read API responses.
// Lock the origin down before any real deployment.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "content-type, authorization");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "jungle-backend" });
});

// --- REST: setup + history (used by the test now, the frontend later) ---

// Strip server-only secrets before a participant row leaves the backend. runner_token
// authenticates an agent's runner socket — it must NEVER reach clients.
function publicParticipant<T extends { runner_token?: unknown }>(p: T): Omit<T, "runner_token"> {
  const { runner_token: _secret, ...pub } = p;
  return pub;
}

app.get("/api/participants", async (_req, res) => {
  try {
    res.json((await db.listParticipants()).map(publicParticipant));
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

app.post("/api/participants", async (req, res) => {
  try {
    const { kind, handle, displayName } = req.body ?? {};
    if (!kind || !handle || !displayName) {
      return res.status(400).json({ error: "kind, handle, displayName required" });
    }
    res.status(201).json(await db.createParticipant({ kind, handle, displayName }));
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// --- Identity & onboarding (real auth: Firebase Google sign-in) ---

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,29}$/; // 2–30 chars, lowercase/digits/_/-, no leading symbol

// Derive a starter handle from the Google profile (email local-part or name).
function suggestHandle(u: auth.AuthUser): string {
  const base = (u.email?.split("@")[0] || u.name || "user")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return base.length >= 2 ? base : "user";
}

// Who am I? Returns the linked participant, or onboarding hints if this Google user is new.
app.get("/api/me", auth.requireAuth, async (req, res) => {
  try {
    const u = auth.authedUser(req)!;
    const p = await db.getParticipantByFirebaseUid(u.uid);
    if (p) {
      const gid = await db.getGithubIdentity(p.id);
      return res.json({ onboarded: true, participant: publicParticipant(p), github: gid ? { connected: true, login: gid.github_login } : { connected: false } });
    }
    let suggested = suggestHandle(u);
    if (!(await db.handleAvailable(suggested))) suggested = `${suggested}-${Math.random().toString(36).slice(2, 5)}`;
    res.json({ onboarded: false, profile: u, suggestedHandle: suggested });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Is a handle valid + free? (drives the onboarding handle field)
app.get("/api/handle-available", async (req, res) => {
  const handle = String(req.query.handle ?? "").trim();
  if (!HANDLE_RE.test(handle)) return res.json({ available: false, valid: false });
  res.json({ available: await db.handleAvailable(handle), valid: true });
});

// Complete onboarding: create the human participant linked to this Firebase user. Idempotent.
app.post("/api/onboarding", auth.requireAuth, async (req, res) => {
  try {
    const u = auth.authedUser(req)!;
    const existing = await db.getParticipantByFirebaseUid(u.uid);
    if (existing) return res.status(200).json(existing);
    const handle = String(req.body?.handle ?? "").trim();
    const displayName = String(req.body?.displayName ?? "").trim() || u.name || handle;
    if (!HANDLE_RE.test(handle)) {
      return res.status(400).json({ error: "handle must be 2–30 chars: lowercase letters, digits, - or _" });
    }
    if (!(await db.handleAvailable(handle))) {
      return res.status(409).json({ error: "that handle is taken" });
    }
    const p = await db.createParticipant({
      kind: "human", handle, displayName,
      firebaseUid: u.uid, email: u.email, avatarUrl: u.picture,
    });
    res.status(201).json(p);
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

app.post("/api/channels", async (req, res) => {
  try {
    const { name, kind, memberHandles } = req.body ?? {};
    if (!name || !kind) return res.status(400).json({ error: "name, kind required" });
    res.status(201).json(await db.createChannel({ name, kind, memberHandles: memberHandles ?? [] }));
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Create an agent = a participant of kind 'agent' running on the SDK runner: mint a per-agent
// runner token and provision its container. If `repo` ("owner/name") is given, the runner
// clones it and gets a fresh GitHub installation token in each `configure` (see runners.ts).
// Models an agent may run (id must be a real model; keep in sync with the UI dropdown).
const ALLOWED_MODELS = new Set(["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-4-8"]);
// SDK runner permission modes (docs/runner-protocol.md §"Permission modes").
const ALLOWED_SDK_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"]);

app.post("/api/agents", async (req, res) => {
  try {
    const { handle, displayName, repo } = req.body ?? {};
    if (!handle || !displayName) {
      return res.status(400).json({ error: "handle, displayName required" });
    }
    const model = req.body?.model ? String(req.body.model) : null;
    if (model && !ALLOWED_MODELS.has(model)) return res.status(400).json({ error: `unsupported model: ${model}` });
    const mode = req.body?.mode ? String(req.body.mode) : "default";
    if (!ALLOWED_SDK_MODES.has(mode)) {
      return res.status(400).json({ error: `unsupported mode: ${mode}` });
    }
    const runnerToken = randomBytes(32).toString("hex");
    const participant = await db.createParticipant({
      kind: "agent", handle, displayName, runtime: "sdk", runnerToken, repo: repo ?? null, model, mode,
    });
    // Provision + start the container. Best-effort: if docker isn't available the agent row
    // still exists and a runner can be started later; surface the error but don't 500 away
    // the created agent.
    try {
      await provisioner.create({ id: participant.id, handle, runnerToken });
      await provisioner.start(participant.id);
    } catch (e) {
      console.error("provisioner create/start:", e);
    }
    return res.status(201).json(publicParticipant(participant));
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Update an agent's config from its profile page. Auth-gated (any signed-in user).
// `mode` is pushed live to the runner (applies immediately); `model` is applied at the
// agent's next turn boundary.
app.patch("/api/agents/:id", async (req, res) => {
  try {
    const me = await requester(req);
    if (!me) return res.status(401).json({ error: "auth required" });
    const agent = await db.getParticipant(req.params.id);
    if (!agent || agent.kind !== "agent") return res.status(404).json({ error: "agent not found" });

    const patch: { displayName?: string; mode?: string; model?: string } = {};
    if (req.body?.displayName !== undefined) {
      const dn = String(req.body.displayName).trim();
      if (!dn) return res.status(400).json({ error: "display name cannot be empty" });
      patch.displayName = dn;
    }
    if (req.body?.mode !== undefined) {
      const mode = String(req.body.mode);
      if (!ALLOWED_SDK_MODES.has(mode)) return res.status(400).json({ error: `unsupported mode: ${mode}` });
      if (mode !== agent.mode) runners.setPermissionMode(agent.id, mode);
      patch.mode = mode;
    }
    if (req.body?.model !== undefined) {
      const model = String(req.body.model);
      if (!ALLOWED_MODELS.has(model)) return res.status(400).json({ error: `unsupported model: ${model}` });
      if (model !== agent.model) runners.setModel(agent.id, model);
      patch.model = model;
    }
    const updated = await db.updateAgentConfig(agent.id, patch);
    const pub = updated ? publicParticipant(updated) : updated;
    broadcastAll({ type: "participant_updated", participant: pub });
    res.json(pub);
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Delete an agent entirely: tear down its runner + container/volume, then remove all of its
// data. Auth-gated (any signed-in user, matching PATCH). Best-effort on the container teardown
// so a docker hiccup doesn't strand the DB row; the DB delete is the source of truth.
app.delete("/api/agents/:id", async (req, res) => {
  try {
    const me = await requester(req);
    if (!me) return res.status(401).json({ error: "auth required" });
    const agent = await db.getParticipant(req.params.id);
    if (!agent || agent.kind !== "agent") return res.status(404).json({ error: "agent not found" });

    // Stop the runner working and close its socket so it can't reconnect mid-teardown.
    runners.disconnect(agent.id);
    // Remove the container + its workspace volume. Best-effort: log but don't fail the request.
    try {
      await provisioner.destroy(agent.id);
    } catch (e) {
      console.error("provisioner destroy:", e);
    }
    await db.deleteAgent(agent.id);
    broadcastAll({ type: "participant_deleted", participantId: agent.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Activity feed history for an sdk agent: persisted SDK stream events, oldest-first within
// the returned page. Live updates ride the app WS as `agent_event` broadcasts.
app.get("/api/agents/:id/events", async (req, res) => {
  try {
    const me = await requester(req);
    if (!me) return res.status(401).json({ error: "auth required" });
    const agent = await db.getParticipant(req.params.id);
    if (!agent || agent.kind !== "agent") return res.status(404).json({ error: "agent not found" });
    const before = req.query.before ? Number(req.query.before) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const rows = await db.listAgentEvents(agent.id, { before, limit });
    rows.reverse(); // newest-first from the DB -> oldest-first for rendering
    res.json({ events: rows, runner: runners.runnerState(agent.id) });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Interrupt an sdk agent's running turn (the Activity pane's Stop button). Queued messages
// are not discarded — they're consumed at the next turn boundary.
app.post("/api/agents/:id/interrupt", async (req, res) => {
  try {
    const me = await requester(req);
    if (!me) return res.status(401).json({ error: "auth required" });
    const agent = await db.getParticipant(req.params.id);
    if (!agent || agent.kind !== "agent") return res.status(404).json({ error: "agent not found" });
    const delivered = runners.interrupt(agent.id);
    res.json({ ok: delivered, ...(delivered ? {} : { error: "runner not connected" }) });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Approve/deny a pending tool confirmation card. Resolving here fulfils the promise runners.ts
// is awaiting for that confirm, which then relays the decision to the runner as a
// `confirm_result` frame.
app.post("/api/agents/confirm", async (req, res) => {
  try {
    const me = await requester(req);
    if (!me) return res.status(401).json({ error: "auth required" });
    const confirmId = String(req.body?.confirmId ?? "");
    const decision = req.body?.decision === "allow" ? "allow" : "deny";
    const pending = pendingConfirms.get(confirmId);
    if (!pending) return res.status(404).json({ error: "confirmation not found or already resolved" });
    if (!(await db.isMember(pending.channelId, me.id))) {
      return res.status(403).json({ error: "not a member of this channel" });
    }
    clearTimeout(pending.timer);
    pendingConfirms.delete(confirmId);
    pending.resolve(
      decision === "allow"
        ? { result: "allow" }
        : { result: "deny", denyMessage: `Denied by @${me.handle}.` },
    );
    await fanOut(pending.channelId, {
      type: "tool_confirmation_resolved",
      confirmId,
      channelId: pending.channelId,
      result: decision,
      by: me.handle,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// --- Attachments ---

// Upload-first (Slack-style): POST raw bytes, get back an attachment id + signed URL; posting
// a message with attachmentIds links them. Auth: a signed-in human (requester) or an agent's
// runner (x-runner-token header). Bytes ride raw in the body with filename/mime in the query,
// so the global JSON body parser never touches an upload.
app.post(
  "/api/attachments",
  express.raw({ type: "*/*", limit: att.MAX_ATTACHMENT_BYTES + 1024 * 1024 }),
  async (req, res) => {
    try {
      let uploaderId = (await requester(req))?.id ?? null;
      if (!uploaderId) {
        const rt = String(req.headers["x-runner-token"] ?? "");
        if (rt) uploaderId = (await db.agentByRunnerToken(rt))?.id ?? null;
      }
      if (!uploaderId) return res.status(401).json({ error: "auth required" });
      const data = req.body as Buffer;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        return res.status(400).json({ error: "empty upload" });
      }
      if (data.length > att.MAX_ATTACHMENT_BYTES) {
        return res.status(413).json({ error: `file exceeds the ${Math.floor(att.MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB limit` });
      }
      const filename = att.sanitizeFilename(String(req.query.filename ?? "file"));
      const rawMime = String(req.query.mime ?? "");
      const mime = /^[\w.+-]+\/[\w.+-]+$/.test(rawMime) ? rawMime.toLowerCase() : "application/octet-stream";
      // Image dimensions are a layout hint only; failure to parse just leaves them null.
      let width: number | null = null;
      let height: number | null = null;
      if (att.isInlineImage(mime)) {
        try {
          const dim = imageSize(data);
          width = dim.width ?? null;
          height = dim.height ?? null;
        } catch {
          /* not decodable — fine */
        }
      }
      const storageKey = `attachments/${randomBytes(16).toString("hex")}`;
      await storage.put(storageKey, data);
      const row = await db.createAttachment({
        uploaderId, filename, mime, sizeBytes: data.length, storageKey, width, height,
      });
      res.status(201).json({
        id: row.id,
        filename: row.filename,
        mime: row.mime,
        size_bytes: Number(row.size_bytes),
        width: row.width,
        height: row.height,
        url: att.signedPath(row.id),
      });
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message ?? e) });
    }
  },
);

// Serve attachment bytes. Auth = a valid, unexpired signature (capability URL) — the only
// scheme that works for both <img> tags and runner downloads. Allowlisted images render
// inline; everything else is forced to download as a generic octet-stream so an uploaded
// .html/.svg can never execute on our origin (stored-XSS defense).
app.get("/api/attachments/:id", async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!att.verifySignature(id, String(req.query.e ?? ""), String(req.query.sig ?? ""))) {
      return res.status(403).json({ error: "invalid or expired link" });
    }
    const row = await db.getAttachment(id);
    if (!row) return res.status(404).json({ error: "attachment not found" });
    const inline = att.isInlineImage(row.mime);
    res.setHeader("content-type", inline ? row.mime : "application/octet-stream");
    res.setHeader("content-length", String(row.size_bytes));
    res.setHeader(
      "content-disposition",
      `${inline ? "inline" : "attachment"}; filename="${row.filename}"`,
    );
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "private, max-age=3600");
    (await storage.stream(row.storage_key)).pipe(res);
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Find-or-create the 1:1 DM channel between two participants (dedupes, unlike POST /channels).
app.post("/api/dms", async (req, res) => {
  try {
    const { participantId, otherId } = req.body ?? {};
    if (!participantId || !otherId) {
      return res.status(400).json({ error: "participantId, otherId required" });
    }
    const id = await db.findOrCreateDm(participantId, otherId);
    res.status(201).json({ id, kind: "dm" });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

app.get("/api/channels", async (req, res) => {
  try {
    const participantId = (req.query.participantId as string | undefined) || undefined;
    res.json(await db.listChannels(participantId));
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

app.get("/api/channels/:id/messages", async (req, res) => {
  try {
    const afterSeq = Number(req.query.afterSeq ?? 0);
    res.json((await db.getMessages(req.params.id, afterSeq)).map(att.withUrls));
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Mark a channel read for the requester (Slack-style): advance their last_read_seq to the
// channel's max message seq, or to a client-supplied `seq`. Requester-gated + membership-gated
// like the other channel endpoints. Returns the resulting last_read_seq.
app.post("/api/channels/:id/read", async (req, res) => {
  try {
    const ctx = await requireChannelMember(req, res);
    if (!ctx) return;
    const rawSeq = req.body?.seq;
    const seq = rawSeq != null && Number.isFinite(Number(rawSeq)) ? Number(rawSeq) : undefined;
    const lastReadSeq = await db.markChannelRead(ctx.channel.id, ctx.me.id, seq);
    res.json({ ok: true, lastReadSeq });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// --- Threads ---

// Thread transcript (root + replies, seq order) for lazy-loading a thread the client doesn't
// already hold locally. Membership-gated; the root must live in the named channel.
app.get("/api/channels/:id/threads/:rootId", async (req, res) => {
  try {
    const ctx = await requireChannelMember(req, res);
    if (!ctx) return;
    const rootChannel = await db.getMessageChannelId(req.params.rootId);
    if (rootChannel !== ctx.channel.id) {
      return res.status(404).json({ error: "thread not found in this channel" });
    }
    res.json((await db.getThreadMessages(req.params.rootId)).map(att.withUrls));
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Mark a thread read for the requester (participation-gated thread unreads): advance their
// per-thread last_read_seq to the thread's max seq, or a client-supplied `seq`. Requester-gated
// + membership-gated (of the thread's channel). Returns the resulting last_read_seq.
app.post("/api/threads/:rootId/read", async (req, res) => {
  try {
    const me = await requester(req);
    if (!me) return res.status(401).json({ error: "auth required" });
    const channelId = await db.getMessageChannelId(req.params.rootId);
    if (!channelId) return res.status(404).json({ error: "thread not found" });
    if (!(await db.isMember(channelId, me.id))) {
      return res.status(403).json({ error: "not a member of this channel" });
    }
    const rawSeq = req.body?.seq;
    const seq = rawSeq != null && Number.isFinite(Number(rawSeq)) ? Number(rawSeq) : undefined;
    const lastReadSeq = await db.markThreadRead(req.params.rootId, me.id, seq);
    res.json({ ok: true, lastReadSeq });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// The requester's followed threads (authored root / replied / @mentioned) that have unread
// replies — the "Threads" sidebar view. Member-scoping is enforced inside the query.
app.get("/api/threads/unread", async (req, res) => {
  try {
    const me = await requester(req);
    if (!me) return res.status(401).json({ error: "auth required" });
    res.json(await db.listUnreadThreads(me.id));
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// --- Channel membership: view / add / remove, and delete a channel ---

// Resolve the requester's participant: from a verified Firebase token, or (only under dev
// bypass) a ?participantId=. Returns null when we can't identify a real participant.
async function requester(req: express.Request): Promise<db.Participant | null> {
  const u = auth.authedUser(req);
  if (u) return db.getParticipantByFirebaseUid(u.uid);
  if (auth.DEV_BYPASS) {
    const pid = (req.query.participantId as string) || (req.body?.participantId as string);
    if (pid) return db.getParticipant(pid);
  }
  return null;
}

// Guard: load the channel and confirm the requester is a member. Sends the error response
// itself and returns null on failure; returns { me, channel } on success.
async function requireChannelMember(
  req: express.Request,
  res: express.Response,
): Promise<{ me: db.Participant; channel: { id: string; name: string; kind: string } } | null> {
  const me = await requester(req);
  if (!me) {
    res.status(401).json({ error: "auth required" });
    return null;
  }
  const channel = await db.getChannel(String(req.params.id));
  if (!channel) {
    res.status(404).json({ error: "channel not found" });
    return null;
  }
  if (!(await db.isMember(channel.id, me.id))) {
    res.status(403).json({ error: "not a member of this channel" });
    return null;
  }
  return { me, channel };
}

app.get("/api/channels/:id/members", async (req, res) => {
  try {
    const ctx = await requireChannelMember(req, res);
    if (!ctx) return;
    res.json(await db.channelMembers(ctx.channel.id));
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

app.post("/api/channels/:id/members", async (req, res) => {
  try {
    const ctx = await requireChannelMember(req, res);
    if (!ctx) return;
    if (ctx.channel.kind === "dm") return res.status(400).json({ error: "cannot change members of a DM" });
    const handle = String(req.body?.handle ?? "").trim().replace(/^@/, "");
    const target = await db.getParticipantByHandle(handle);
    if (!target) return res.status(404).json({ error: `no participant @${handle}` });
    await db.addChannelMember(ctx.channel.id, target.id);
    await fanOut(ctx.channel.id, { type: "members_changed", channelId: ctx.channel.id });
    res.status(201).json(target);
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

app.delete("/api/channels/:id/members/:participantId", async (req, res) => {
  try {
    const ctx = await requireChannelMember(req, res);
    if (!ctx) return;
    if (ctx.channel.kind === "dm") return res.status(400).json({ error: "cannot change members of a DM" });
    // Notify (incl. the person being removed) before the row is gone, then remove.
    await fanOut(ctx.channel.id, { type: "members_changed", channelId: ctx.channel.id });
    await db.removeChannelMember(ctx.channel.id, String(req.params.participantId));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

app.delete("/api/channels/:id", async (req, res) => {
  try {
    const ctx = await requireChannelMember(req, res);
    if (!ctx) return;
    if (ctx.channel.kind === "dm") return res.status(400).json({ error: "DMs cannot be deleted" });
    // Fan out to members before deleting (afterwards there are no members to resolve).
    await fanOut(ctx.channel.id, { type: "channel_deleted", channelId: ctx.channel.id });
    await db.deleteChannel(ctx.channel.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// --- GitHub: connect a participant's account (user-OAuth) + open PRs (Step 7) ---

// Pending OAuth round-trips: state -> participantId. In-memory is fine for a single backend.
const pendingOAuth = new Map<string, { participantId: string; createdAt: number }>();

// Step 1 of connect: a human hits this (e.g. a "Connect GitHub" button) and is redirected
// to GitHub to authorize. ?participantId identifies who is connecting (dev path).
app.get("/auth/github", (req, res) => {
  if (!gh.isConfigured()) return res.status(500).send("GitHub App not configured");
  const participantId = (req.query.participantId as string | undefined) || "";
  if (!participantId) return res.status(400).send("participantId required");
  const state = randomBytes(16).toString("hex");
  pendingOAuth.set(state, { participantId, createdAt: Date.now() });
  res.redirect(gh.authorizeUrl(state));
});

// Auth'd variant for the onboarding flow: the server binds the OAuth `state` to the verified
// user's participant (not a client-supplied id), then the SPA navigates to the returned URL.
app.post("/api/github/connect-url", auth.requireAuth, async (req, res) => {
  try {
    if (!gh.isConfigured()) return res.status(500).json({ error: "GitHub App not configured" });
    const u = auth.authedUser(req)!;
    const p = await db.getParticipantByFirebaseUid(u.uid);
    if (!p) return res.status(409).json({ error: "finish onboarding first" });
    const state = randomBytes(16).toString("hex");
    pendingOAuth.set(state, { participantId: p.id, createdAt: Date.now() });
    res.json({ url: gh.authorizeUrl(state) });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Step 2: GitHub redirects back here with ?code & ?state. Exchange + store the identity.
app.get("/auth/github/callback", async (req, res) => {
  try {
    const code = (req.query.code as string | undefined) || "";
    const state = (req.query.state as string | undefined) || "";
    const pending = pendingOAuth.get(state);
    if (!code || !pending) return res.status(400).send("invalid or expired OAuth state");
    pendingOAuth.delete(state);
    const { login } = await gh.exchangeCodeAndStore(pending.participantId, code);
    // Back to the SPA, which reads ?github=connected to advance/refresh the onboarding step.
    res.redirect(`${FRONTEND_URL}/settings?github=connected&login=${encodeURIComponent(login)}`);
  } catch (e) {
    res.redirect(`${FRONTEND_URL}/settings?github=error&reason=${encodeURIComponent(String((e as Error).message ?? e))}`);
  }
});

// GitHub connection + App installation status for the settings page.
app.get("/api/github/status", auth.requireAuth, async (req, res) => {
  try {
    const u = auth.authedUser(req)!;
    const p = await db.getParticipantByFirebaseUid(u.uid);
    if (!p) return res.status(409).json({ error: "finish onboarding first" });
    res.json(await gh.githubStatus(p.id));
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// List the authed user's GitHub repos (via their connected token) for the repo picker.
// 409 (not 500) when GitHub isn't connected, so the UI can fall back to manual entry.
app.get("/api/github/repos", auth.requireAuth, async (req, res) => {
  try {
    const u = auth.authedUser(req)!;
    const p = await db.getParticipantByFirebaseUid(u.uid);
    if (!p) return res.status(409).json({ connected: false, error: "finish onboarding first" });
    if (!(await db.getGithubIdentity(p.id))) {
      return res.status(409).json({ connected: false, error: "github not connected" });
    }
    res.json({ connected: true, repos: await gh.listUserRepos(p.id) });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Disconnect the authed user's GitHub account (removes the stored identity/tokens).
app.delete("/api/github/connection", auth.requireAuth, async (req, res) => {
  try {
    const u = auth.authedUser(req)!;
    const p = await db.getParticipantByFirebaseUid(u.uid);
    if (!p) return res.status(409).json({ error: "finish onboarding first" });
    await db.deleteGithubIdentity(p.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Connection status for a participant (used by the UI to show connected/not).
app.get("/api/participants/:id/github", async (req, res) => {
  try {
    const id = await db.getGithubIdentity(req.params.id);
    res.json(id ? { connected: true, login: id.github_login } : { connected: false });
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Open a PR using a participant's connected token. Used by tests now and reused by the
// agent's open_pr tool (§7c).
app.post("/api/github/open-pr", async (req, res) => {
  try {
    const { participantId, repo, title, body, files, headBranch, baseBranch } = req.body ?? {};
    if (!participantId || !repo || !title || !files) {
      return res.status(400).json({ error: "participantId, repo, title, files required" });
    }
    res.status(201).json(
      await gh.openPullRequest({ participantId, repo, title, body, files, headBranch, baseBranch }),
    );
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Open a PR as the GitHub App bot (installation token). Verifies the bot-identity path
// independent of the agent loop. The agent path (vault + GitHub MCP) builds on this.
app.post("/api/github/bot-open-pr", async (req, res) => {
  try {
    if (!gh.appAuthConfigured()) {
      return res.status(500).json({ error: "GitHub App private key not configured" });
    }
    const { repo, title, body, files, headBranch, baseBranch } = req.body ?? {};
    if (!repo || !title || !files) {
      return res.status(400).json({ error: "repo, title, files required" });
    }
    res.status(201).json(
      await gh.openPrAsBot({ repo, title, body, files, headBranch, baseBranch }),
    );
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// --- WebSocket: realtime messaging ---

const server = createServer(app);
// The app (human/device) WebSocket server. `noServer` because we route upgrades ourselves:
// /api/runner goes to the runner subsystem (runners.init), everything else to this server.
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  let pathname = "/";
  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    /* keep default */
  }
  if (pathname === "/api/runner") return; // handled by runners.init's own upgrade listener
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// participantId -> open sockets (a participant may be connected from several devices)
const sockets = new Map<string, Set<WebSocket>>();

function addSocket(pid: string, ws: WebSocket) {
  let set = sockets.get(pid);
  if (!set) sockets.set(pid, (set = new Set()));
  set.add(ws);
}
function removeSocket(pid: string, ws: WebSocket) {
  const set = sockets.get(pid);
  if (set) {
    set.delete(ws);
    if (!set.size) sockets.delete(pid);
  }
}

// Fan out a payload to every connected device of every member of a channel.
async function fanOut(channelId: string, payload: unknown) {
  const data = JSON.stringify(payload);
  for (const pid of await db.channelMemberIds(channelId)) {
    const set = sockets.get(pid);
    if (set) for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// Broadcast to every connected socket (workspace-wide events, e.g. a participant's profile
// changed — everyone's People list / open profile should reflect it).
function broadcastAll(payload: unknown) {
  const data = JSON.stringify(payload);
  for (const set of sockets.values()) {
    for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// --- Tool confirmations ---
// A tool call awaiting a human's allow/deny. Kept in memory (single backend); the WS card
// the human clicks resolves the promise the runner's confirm_request is awaiting.
// A decision can carry updatedInput (SDK canUseTool "allow with edited input").
type ConfirmDecision = { result: "allow" | "deny"; denyMessage?: string; updatedInput?: unknown };
interface PendingConfirm {
  channelId: string;
  agentId: string;
  resolve: (d: ConfirmDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingConfirms = new Map<string, PendingConfirm>();
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000; // auto-deny if nobody answers, so the turn can't wedge

// Surface a tool-confirmation card into a channel and return a promise that resolves when a
// human decides (via /api/agents/confirm) or the timeout auto-denies. Shared by both runtimes.
function surfaceConfirmCard(
  agent: { id: string; handle: string; display_name: string },
  channelId: string,
  tool: string,
  input: unknown,
): Promise<ConfirmDecision> {
  const confirmId = randomBytes(9).toString("hex");
  return new Promise<ConfirmDecision>((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingConfirms.has(confirmId)) return;
      pendingConfirms.delete(confirmId);
      void fanOut(channelId, { type: "tool_confirmation_resolved", confirmId, channelId, result: "deny" });
      resolve({ result: "deny", denyMessage: "No human responded in time; the action was skipped." });
    }, CONFIRM_TIMEOUT_MS);
    pendingConfirms.set(confirmId, { channelId, agentId: agent.id, resolve, timer });
    void fanOut(channelId, {
      type: "tool_confirmation_request",
      confirmId,
      channelId,
      agentId: agent.id,
      agentHandle: agent.handle,
      agentName: agent.display_name,
      tool,
      input,
    });
  });
}

// A human message starts a cascade with this budget; each agent->agent hop decrements
// it. At 0, agents stop auto-replying until a human speaks again. Bounds loops + cost.
const DEFAULT_CASCADE_BUDGET = 3;

// If a message addresses an agent (via @mention, or by being the other member of a DM),
// run that agent's turn and post its reply back. Async / fire-and-forget so posting stays
// fast. The reply itself re-enters this function (agent->agent), gated by cascade_budget.
async function triggerMentionedAgents(
  channelId: string,
  message: db.PersistedMessage,
  senderKind: "human" | "agent",
) {
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

    const agents = await db.agentsByIds(candidateIds);
    for (const agent of agents) {
      // Summon the @mentioned agent into the channel so its reply (to:"#channel") succeeds
      // — otherwise mentioning an agent that isn't a member triggers it but it can't respond.
      await db.addChannelMember(channelId, agent.id);
      void runAgentReply(channelId, channel.name, agent, budget - 1, message.attachments, rootId);
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
  threadRootId: string | null = null,
) {
  // Let the channel show "@agent is working…" for the duration of the turn.
  const status = (state: "working" | "idle") =>
    fanOut(triggerChannelId, {
      type: "agent_status", channelId: triggerChannelId, agentId: agent.id, handle: agent.handle, state,
    });
  await status("working");
  try {
    // In a thread, give the agent the THREAD transcript (not the whole channel) and tell it its
    // reply is auto-placed in the thread. Otherwise the usual recent-channel context.
    const input = threadRootId
      ? `You are @${agent.handle} in Jungle. You were addressed in a THREAD in #${triggerChannelName}.\n\n` +
        `Thread so far:\n${await db.getThreadContext(threadRootId)}\n\n` +
        `Reply by calling send_message with to:"#${triggerChannelName}" — your reply is automatically ` +
        `placed in this thread. Set alsoToChannel:true if it should also appear in the main channel. ` +
        `You may also DM someone with to:"@handle".`
      : `You are @${agent.handle} in Jungle. You were addressed in #${triggerChannelName}.\n\n` +
        `Recent conversation:\n${await db.getRecentContext(triggerChannelId, 20)}\n\n` +
        `Respond by calling send_message — to reply in this channel use to:"#${triggerChannelName}". ` +
        `You may also DM someone with to:"@handle", or post in another channel you belong to.`;
    // Repo-specific working instructions live in the runner's systemPromptAppend (runners.ts).

    // Delivery is durable + asynchronous. Remember the reply budget + the channel this dispatch
    // came from (so a send_message with no explicit destination, and the confirm card, land in
    // the right place) + the thread it was triggered in (so the agent's reply defaults back into
    // that thread), enqueue the composed input, and push it to the runner if one is connected.
    // If not, it waits in the inbox until the runner's next `hello`.
    sdkContext.set(agent.id, { budget: replyBudget, channelId: triggerChannelId, threadRootId });
    await db.enqueueInboxItem(agent.id, input, attachments);
    await runners.drain(agent.id);
    // The turn runs asynchronously on the runner; we don't hold "working" for its duration.
  } catch (e) {
    console.error("runAgentReply:", e);
  } finally {
    await status("idle");
  }
}

// Per-agent context for the most recent sdk dispatch: the cascade budget its replies inherit,
// and the channel it was triggered in (used to place a confirm card, and as a fallback
// destination). Overwritten each dispatch; sdk turns are serialized per agent by the runner.
const sdkContext = new Map<string, { budget: number; channelId: string; threadRootId: string | null }>();

// Execute one send_message tool call from an agent: resolve the destination (#channel or
// @handle), post via the routing rule (persist + fan out + cascade), and report back.
async function deliverAgentMessage(
  agent: { id: string; handle: string },
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
    const other = await db.getParticipantByHandle(to.slice(1));
    if (!other) return { ok: false, error: `no participant named ${to}` };
    channelId = await db.findOrCreateDm(agent.id, other.id);
  } else {
    return { ok: false, error: `"to" must start with "#" (channel) or "@" (handle)` };
  }

  // Thread placement: honor an explicit threadRootId from the tool call; otherwise default to
  // the thread this agent was triggered in — but ONLY when replying back into that same channel
  // (a DM / different-channel send is never auto-threaded onto the trigger's root).
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

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  // Real auth: a Firebase ID token (?token=) is verified and mapped to the user's participant.
  // Dev/test: when DEV_BYPASS is on, fall back to a trusted ?participantId=.
  let participantId: string | null = null;
  const token = url.searchParams.get("token");
  if (token && auth.firebaseConfigured()) {
    try {
      const u = await auth.verifyIdToken(token);
      participantId = (await db.getParticipantByFirebaseUid(u.uid))?.id ?? null;
    } catch {
      /* invalid token — fall through to (possible) dev bypass / reject */
    }
  }
  if (!participantId && auth.DEV_BYPASS) {
    participantId = url.searchParams.get("participantId");
  }
  if (!participantId) {
    ws.close(4001, "auth required");
    return;
  }
  addSocket(participantId, ws);
  ws.send(JSON.stringify({ type: "connected", participantId }));

  ws.on("message", async (raw) => {
    let evt: {
      type?: string;
      channelId?: string;
      body?: string;
      clientMsgId?: string;
      attachmentIds?: string[];
      threadRootId?: string | null;
      alsoToChannel?: boolean;
    };
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // The one routing rule (human-only for now): persist -> fan out. A post needs a body
    // and/or pre-uploaded attachments (POST /api/attachments). A post carrying threadRootId is
    // a thread reply (alsoToChannel echoes it into the main timeline too).
    const attachmentIds = (Array.isArray(evt.attachmentIds) ? evt.attachmentIds : [])
      .map(String)
      .slice(0, att.MAX_ATTACHMENTS_PER_MESSAGE);
    if (evt.type === "post" && evt.channelId && (evt.body || attachmentIds.length)) {
      try {
        if (!(await db.isMember(evt.channelId, participantId))) {
          ws.send(JSON.stringify({ type: "error", error: "not a member of channel" }));
          return;
        }
        const message = await db.persistMessage({
          channelId: evt.channelId,
          senderId: participantId,
          body: evt.body ?? "",
          clientMsgId: evt.clientMsgId ?? null,
          cascadeBudget: DEFAULT_CASCADE_BUDGET, // human messages start a fresh cascade
          attachmentIds,
          threadRootId: evt.threadRootId ?? null,
          alsoToChannel: !!evt.alsoToChannel,
        });
        await fanOut(evt.channelId, { type: "message", message: att.withUrls(message) });
        void triggerMentionedAgents(evt.channelId, message, "human");
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", error: String((e as Error).message ?? e) }));
      }
    }
  });

  ws.on("close", () => removeSocket(participantId, ws));
});

// --- SDK runner subsystem ---
// Runners dial into /api/runner (handled by runners.init's own `upgrade` listener). Wire the
// chat-side effects a runner needs back into the same helpers the MA path uses.
runners.init(server, {
  // A runner's send_message -> post it into Jungle, with the cascade budget of the dispatch
  // that triggered this agent (looked up from sdkContext). If the destination is missing we
  // let deliverAgentMessage report the error back to the tool call.
  deliverAgentMessage: (agent, input) => {
    const ctx = sdkContext.get(agent.id);
    return deliverAgentMessage(agent, input, ctx?.budget ?? 0, {
      channelId: ctx?.channelId,
      threadRootId: ctx?.threadRootId ?? null,
    });
  },
  // A runner's confirm_request -> surface a confirmation card in the channel that triggered
  // this agent. Resolving the card (via /api/agents/confirm) resolves this promise; runners.ts
  // then relays the decision to the runner as confirm_result.
  requestConfirm: (agent, confirm) => {
    const channelId = sdkContext.get(agent.id)?.channelId;
    if (!channelId) {
      // No known channel to place the card — deny rather than hang the turn.
      return Promise.resolve({ result: "deny", denyMessage: "no channel context for confirmation" });
    }
    return surfaceConfirmCard(agent, channelId, confirm.toolName, confirm.input);
  },
  // A runner's SDK stream event -> persist for the Activity feed + broadcast to app sockets.
  onAgentEvent: (agentId, turnId, event) => {
    void db.insertAgentEvent(agentId, turnId, event).catch((e) => console.error("insertAgentEvent:", e));
    broadcastAll({ type: "agent_event", agentId, turnId, event });
  },
  // A turn crashed (e.g. OOM-killed SDK process). Post a notice from the agent into the
  // channel that triggered it so the humans waiting aren't ghosted. cascadeBudget 0: a
  // crash notice must never trigger other agents.
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
});

// Hourly attachment GC: abandoned composer uploads (never linked to a message) and blobs
// whose rows were removed by FK cascades (deleted messages/channels/agents).
setInterval(() => void att.gcOrphans().catch((e) => console.error("attachment gc:", e)), 60 * 60 * 1000).unref();

const PORT = Number(process.env.PORT ?? 3001);
server.listen(PORT, () => console.log(`jungle-backend on http://localhost:${PORT}`));
