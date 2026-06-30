import "./env";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import * as db from "./db";
import * as ma from "./ma";
import * as gh from "./github";

const app = express();
app.use(express.json());

// MVP CORS: the frontend (a different origin in dev) needs to read API responses.
// Lock the origin down before any real deployment.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "content-type");
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
app.post("/api/agents", async (req, res) => {
  try {
    const { handle, displayName, repo } = req.body ?? {};
    if (!handle || !displayName) {
      return res.status(400).json({ error: "handle, displayName required" });
    }
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
      );
      return res.status(201).json(
        await db.createParticipant({
          kind: "agent", handle, displayName, maSessionId: sessionId,
          repo, vaultId, repoResourceId, mcpCredentialId: credentialId,
        }),
      );
    }
    const maSessionId = await ma.createAgentSession(`jungle agent @${handle}`);
    res.status(201).json(await db.createParticipant({ kind: "agent", handle, displayName, maSessionId }));
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

// --- GitHub: connect a participant's account (user-OAuth) + open PRs (Step 7) ---

// Pending OAuth round-trips: state -> participantId. In-memory is fine for a single backend.
const pendingOAuth = new Map<string, { participantId: string; createdAt: number }>();

// Step 1 of connect: a human hits this (e.g. a "Connect GitHub" button) and is redirected
// to GitHub to authorize. ?participantId identifies who is connecting.
app.get("/auth/github", (req, res) => {
  if (!gh.isConfigured()) return res.status(500).send("GitHub App not configured");
  const participantId = (req.query.participantId as string | undefined) || "";
  if (!participantId) return res.status(400).send("participantId required");
  const state = randomBytes(16).toString("hex");
  pendingOAuth.set(state, { participantId, createdAt: Date.now() });
  res.redirect(gh.authorizeUrl(state));
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
    res.send(`<h2>✅ GitHub connected as @${login}</h2><p>You can close this tab.</p>`);
  } catch (e) {
    res.status(500).send(`GitHub connect failed: ${String((e as Error).message ?? e)}`);
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
    for (const agent of agents) void runAgentReply(channelId, channel.name, agent, budget - 1);
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
    const input =
      `You are @${agent.handle} in Jungle. You were addressed in #${triggerChannelName}.\n\n` +
      `Recent conversation:\n${context}\n\n` +
      `Respond by calling send_message — to reply in this channel use to:"#${triggerChannelName}". ` +
      `You may also DM someone with to:"@handle", or post in another channel you belong to.`;
    await ma.runAgentTurn(agent.ma_session_id, input, (toolInput) =>
      deliverAgentMessage(agent, toolInput, replyBudget),
    );
  } catch (e) {
    console.error("runAgentReply:", e);
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

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const participantId = url.searchParams.get("participantId");
  if (!participantId) {
    ws.close(4001, "participantId required");
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
