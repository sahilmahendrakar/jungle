import "./env";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import * as db from "./db";
import * as ma from "./ma";
import * as gh from "./github";
import * as auth from "./auth";

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
  res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
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

app.get("/api/participants", async (_req, res) => {
  try {
    res.json(await db.listParticipants());
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

app.post("/api/participants", async (req, res) => {
  try {
    const { kind, handle, displayName, maSessionId } = req.body ?? {};
    if (!kind || !handle || !displayName) {
      return res.status(400).json({ error: "kind, handle, displayName required" });
    }
    res.status(201).json(await db.createParticipant({ kind, handle, displayName, maSessionId }));
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
      return res.json({ onboarded: true, participant: p, github: gid ? { connected: true, login: gid.github_login } : { connected: false } });
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

// Create an agent = one MA session + a participant of kind 'agent'. If `repo` ("owner/name")
// is given, provision a GitHub-capable agent: mint a repo-scoped installation token, build a
// vault with the GitHub MCP credential, and create the session with the repo mounted.
// Models an agent may run (id must be a real model; keep in sync with the UI dropdown).
const ALLOWED_MODELS = new Set(["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-4-8"]);
const ALLOWED_MODES = new Set(["always_ask", "always_allow"]);

app.post("/api/agents", async (req, res) => {
  try {
    const { handle, displayName, repo } = req.body ?? {};
    if (!handle || !displayName) {
      return res.status(400).json({ error: "handle, displayName required" });
    }
    const model = req.body?.model ? String(req.body.model) : null;
    if (model && !ALLOWED_MODELS.has(model)) return res.status(400).json({ error: `unsupported model: ${model}` });
    const mode = req.body?.mode ? String(req.body.mode) : "always_allow";
    if (!ALLOWED_MODES.has(mode)) return res.status(400).json({ error: `unsupported mode: ${mode}` });

    if (repo) {
      if (!gh.appAuthConfigured()) {
        return res.status(500).json({ error: "GitHub App private key not configured" });
      }
      const token = await gh.installationTokenForRepo(repo);
      const { vaultId, credentialId } = await ma.createMcpVault(
        `jungle @${handle}`, gh.GITHUB_MCP_URL, token,
      );
      const { sessionId, repoResourceId } = await ma.createRepoAgentSession(
        `jungle agent @${handle}`,
        { repoUrl: `https://github.com/${repo}`, repoToken: token, vaultId },
        model,
        mode as ma.AgentMode,
      );
      return res.status(201).json(
        await db.createParticipant({
          kind: "agent", handle, displayName, maSessionId: sessionId,
          repo, vaultId, repoResourceId, mcpCredentialId: credentialId, model, mode,
        }),
      );
    }
    const maSessionId = await ma.createAgentSession(`jungle agent @${handle}`, model, mode as ma.AgentMode);
    res.status(201).json(
      await db.createParticipant({ kind: "agent", handle, displayName, maSessionId, model, mode }),
    );
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Update an agent's config from its profile page. Auth-gated (any signed-in user).
// `mode` is applied live to the MA session; `model` is read-only (fixed at creation).
app.patch("/api/agents/:id", async (req, res) => {
  try {
    const me = await requester(req);
    if (!me) return res.status(401).json({ error: "auth required" });
    const agent = await db.getParticipant(req.params.id);
    if (!agent || agent.kind !== "agent") return res.status(404).json({ error: "agent not found" });

    const patch: { displayName?: string; mode?: string } = {};
    if (req.body?.displayName !== undefined) {
      const dn = String(req.body.displayName).trim();
      if (!dn) return res.status(400).json({ error: "display name cannot be empty" });
      patch.displayName = dn;
    }
    if (req.body?.mode !== undefined) {
      const mode = String(req.body.mode);
      if (!ALLOWED_MODES.has(mode)) return res.status(400).json({ error: `unsupported mode: ${mode}` });
      // Apply the permission-policy change to the live session before persisting.
      if (mode !== agent.mode && agent.ma_session_id) {
        await ma.updateSessionMode(agent.ma_session_id, !!agent.repo, mode as ma.AgentMode);
      }
      patch.mode = mode;
    }
    const updated = await db.updateAgentConfig(agent.id, patch);
    broadcastAll({ type: "participant_updated", participant: updated });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: String((e as Error).message ?? e) });
  }
});

// Approve/deny a pending tool confirmation (from an always_ask agent's card).
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
    res.json(await db.getMessages(req.params.id, afterSeq));
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
    res.redirect(`${FRONTEND_URL}/?github=connected&login=${encodeURIComponent(login)}`);
  } catch (e) {
    res.redirect(`${FRONTEND_URL}/?github=error&reason=${encodeURIComponent(String((e as Error).message ?? e))}`);
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
const wss = new WebSocketServer({ server });

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

// --- Tool confirmations (always_ask agents) ---
// A tool call awaiting a human's allow/deny. Kept in memory (single backend); the WS card
// the human clicks resolves the promise the agent turn is awaiting.
interface PendingConfirm {
  channelId: string;
  agentId: string;
  resolve: (d: ma.ConfirmDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingConfirms = new Map<string, PendingConfirm>();
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000; // auto-deny if nobody answers, so the turn can't wedge

// Build the onConfirm callback for one agent turn: always_allow auto-approves; always_ask
// surfaces a confirmation card into the channel and waits for a human decision.
function makeOnConfirm(agent: db.AgentRow, channelId: string) {
  return (req: ma.ToolConfirmRequest): Promise<ma.ConfirmDecision> => {
    if (agent.mode !== "always_ask") return Promise.resolve({ result: "allow" });
    const confirmId = randomBytes(9).toString("hex");
    return new Promise<ma.ConfirmDecision>((resolve) => {
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
        tool: req.name,
        input: req.input,
      });
    });
  };
}

// A human message starts a cascade with this budget; each agent->agent hop decrements
// it. At 0, agents stop auto-replying until a human speaks again. Bounds loops + cost.
const DEFAULT_CASCADE_BUDGET = 3;

// If a message addresses an agent (via @mention, or by being the other member of a DM),
// run that agent's turn and post its reply back. Async / fire-and-forget so posting stays
// fast. The reply itself re-enters this function (agent->agent), gated by cascade_budget.
async function triggerMentionedAgents(channelId: string, message: db.PersistedMessage) {
  try {
    const budget = message.cascade_budget ?? 0;
    if (budget <= 0) return; // cascade exhausted — wait for a human to speak again
    const channel = await db.getChannel(channelId);
    if (!channel) return;
    let candidateIds = message.mentions.map((m) => m.id);
    if (channel.kind === "dm" && !candidateIds.length) {
      candidateIds = await db.channelMemberIds(channelId);
    }
    candidateIds = candidateIds.filter((id) => id !== message.sender_id); // never self-trigger
    const agents = await db.agentsByIds(candidateIds);
    for (const agent of agents) {
      // Summon the @mentioned agent into the channel so its reply (to:"#channel") succeeds
      // — otherwise mentioning an agent that isn't a member triggers it but it can't respond.
      await db.addChannelMember(channelId, agent.id);
      void runAgentReply(channelId, channel.name, agent, budget - 1);
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
) {
  // Let the channel show "@agent is working…" for the duration of the turn.
  const status = (state: "working" | "idle") =>
    fanOut(triggerChannelId, {
      type: "agent_status", channelId: triggerChannelId, agentId: agent.id, handle: agent.handle, state,
    });
  await status("working");
  try {
    // GitHub-capable agent: refresh its (≤1h) installation token before the turn so git +
    // the GitHub MCP server stay authenticated. Best-effort — a still-valid token survives.
    if (agent.repo && agent.vault_id && agent.mcp_credential_id) {
      try {
        const token = await gh.installationTokenForRepo(agent.repo);
        await ma.rotateRepoAuth({
          sessionId: agent.ma_session_id,
          repoResourceId: agent.repo_resource_id ?? "",
          vaultId: agent.vault_id,
          credentialId: agent.mcp_credential_id,
          token,
        });
      } catch (e) {
        console.error("rotateRepoAuth:", e);
      }
    }
    const context = await db.getRecentContext(triggerChannelId, 20);
    let input =
      `You are @${agent.handle} in Jungle. You were addressed in #${triggerChannelName}.\n\n` +
      `Recent conversation:\n${context}\n\n` +
      `Respond by calling send_message — to reply in this channel use to:"#${triggerChannelName}". ` +
      `You may also DM someone with to:"@handle", or post in another channel you belong to.`;

    // Attribute git work to the agent (not the shared app bot). Commits made via git in the
    // mounted repo carry whatever git identity is configured, so we set it to the agent and
    // tell it to commit with git — using the GitHub tools only to open the PR.
    if (agent.repo) {
      const gitName = agent.display_name || agent.handle;
      const gitEmail = `${agent.handle}@agents.jungle.dev`;
      input +=
        `\n\n— Working on ${agent.repo} —\n` +
        `The repo is mounted. Make and COMMIT your changes with git (not the GitHub file-write ` +
        `tools) so the commits are authored as you. Before committing, run once:\n` +
        `  git config user.name ${JSON.stringify(gitName)}\n` +
        `  git config user.email ${JSON.stringify(gitEmail)}\n` +
        `Then push your branch and use the GitHub tools only to open the pull request. ` +
        `(The PR is opened by the Jungle app; your commits will show "${gitName}" as the author.)`;
    }
    await ma.runAgentTurn(agent.ma_session_id, input, {
      onSend: (toolInput) => deliverAgentMessage(agent, toolInput, replyBudget),
      onConfirm: makeOnConfirm(agent, triggerChannelId),
    });
  } catch (e) {
    console.error("runAgentReply:", e);
  } finally {
    await status("idle");
  }
}

// Execute one send_message tool call from an agent: resolve the destination (#channel or
// @handle), post via the routing rule (persist + fan out + cascade), and report back.
async function deliverAgentMessage(
  agent: { id: string; handle: string },
  toolInput: ma.SendMessageInput,
  budget: number,
): Promise<ma.SendMessageResult> {
  const to = String(toolInput.to ?? "").trim();
  const body = String(toolInput.body ?? "").trim();
  if (!body) return { ok: false, error: "body is required" };

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

  const msg = await db.persistMessage({ channelId, senderId: agent.id, body, cascadeBudget: budget });
  await fanOut(channelId, { type: "message", message: msg });
  void triggerMentionedAgents(channelId, msg);
  return { ok: true, messageId: msg.id };
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
    let evt: { type?: string; channelId?: string; body?: string; clientMsgId?: string };
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // The one routing rule (human-only for now): persist -> fan out.
    if (evt.type === "post" && evt.channelId && evt.body) {
      try {
        if (!(await db.isMember(evt.channelId, participantId))) {
          ws.send(JSON.stringify({ type: "error", error: "not a member of channel" }));
          return;
        }
        const message = await db.persistMessage({
          channelId: evt.channelId,
          senderId: participantId,
          body: evt.body,
          clientMsgId: evt.clientMsgId ?? null,
          cascadeBudget: DEFAULT_CASCADE_BUDGET, // human messages start a fresh cascade
        });
        await fanOut(evt.channelId, { type: "message", message });
        void triggerMentionedAgents(evt.channelId, message);
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", error: String((e as Error).message ?? e) }));
      }
    }
  });

  ws.on("close", () => removeSocket(participantId, ws));
});

const PORT = Number(process.env.PORT ?? 3001);
server.listen(PORT, () => console.log(`jungle-backend on http://localhost:${PORT}`));
