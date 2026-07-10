// Core runner: bridges a Claude Agent SDK session to the Jungle backend.
//
// Turn loop:
//   - queue holds {inboxId, text}. When idle and queue non-empty, drain ALL
//     queued items as one batch, emit turn_started + consumed, and run one
//     streaming query() whose generator yields the batch as a single user
//     message. Messages arriving while the query runs ARE streamed into it as
//     follow-up user messages (mid-turn splice): the CLI either folds one
//     into the turn in progress or queues it as the next turn — both fully
//     supported, exactly like typing into interactive Claude Code.
//   - Ending the query is the delicate part. The CLI treats stdin EOF (our
//     input generator returning) as "no more input": once `inputClosed` is
//     set, EVERY control request — hook callbacks, canUseTool, in-process
//     SDK-MCP calls — throws "Stream closed". Closing the input while a
//     spliced follow-up turn is still queued therefore runs that turn with
//     dead wiring: PreToolUse hooks error out (so default-mode confirmation
//     gating silently FALLS THROUGH TO ALLOW) and every send_message fails
//     with "Stream closed". That — our own premature close in the old
//     endTurnIfQuiescent, not a CLI defect — was the long-open prod "agent
//     goes mute for a whole turn" bug (root-caused 2026-07-06 via CLI debug
//     stderr: sendRequest throwing on inputClosed; deterministic repro in
//     /tmp/splice-repro and backend/test/integration-sdk.mjs).
//   - So the close rule is: at a `result`, close immediately only when every
//     user message we yielded has produced a result (yields <= results).
//     A spliced message may FOLD into the running turn (one result for two
//     yields — undetectable from the stream), so when yields > results we
//     instead close after a short quiescence window with no stream activity;
//     any activity means the queued turn started, and its own result
//     re-evaluates the rule. A pending model change still ends the query
//     directly (restart with resume).
import {
  query,
  type EffortLevel,
  type McpServerConfig,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "./log.js";
import { Connection } from "./connection.js";
import {
  createJungleMcpServer,
  type SendMessageResult,
  type ReadHistoryResult,
  type ScheduleCreateResult,
  type ScheduleListResult,
  type ScheduleCancelResult,
} from "./send-message-tool.js";
import { createGmailMcpServer } from "./gmail-tool.js";
import { createDriveMcpServer } from "./drive-tool.js";
import { createXMcpServer } from "./x-tool.js";
import { applyGitCredentials, cloneRepoIfNeeded, getGhToken } from "./git.js";
import { loadState, saveState } from "./state.js";
import {
  downloadAttachments,
  httpBaseFromWsUrl,
  inlineableImage,
  uploadFile,
} from "./files.js";
import {
  PROTOCOL_VERSION,
  type BackendToRunner,
  type ConfigureFrame,
  type EnqueueAttachment,
  type McpIntegrationGrant,
  type PermissionMode,
} from "./protocol.js";

interface QueueItem {
  inboxId: string;
  text: string;
  attachments?: EnqueueAttachment[];
}

export interface RunnerEnv {
  agentId: string;
  wsUrl: string;
  token: string;
}

// Tools that never need a human in `default` mode: read-only, informational, or
// SDK-internal (ToolSearch loads tool schemas; TodoWrite is the agent's own bookkeeping).
// Everything NOT listed (Bash, Write, Edit, NotebookEdit, external MCP tools, …) asks.
const SAFE_TOOLS = new Set([
  "ToolSearch", "Read", "Glob", "Grep", "WebSearch", "WebFetch",
  "TodoWrite", "Task", "NotebookRead", "BashOutput", "TaskOutput",
  "ListMcpResources", "ReadMcpResource", "mcp__jungle__read_history",
  // Gmail read/search: never mutate the mailbox, so no confirmation.
  "mcp__gmail__gmail_search", "mcp__gmail__gmail_read_message",
  // Google Drive read: search/list/get never mutate, so no confirmation.
  "mcp__gdrive__drive_search", "mcp__gdrive__drive_list", "mcp__gdrive__drive_get_file",
  // X (Twitter) is read-only by design — every x_* tool runs without a confirmation.
  "mcp__x__x_my_recent_tweets", "mcp__x__x_mentions", "mcp__x__x_replies_to_me",
  "mcp__x__x_notifications", "mcp__x__x_search", "mcp__x__x_get_user",
  // Schedule tools are bounded jungle-app operations with backend-enforced guardrails (caps,
  // min interval, prompt cap) and full human visibility/undo on the Scheduled page — a confirm
  // card would be noise, not safety.
  "mcp__jungle__schedule_create", "mcp__jungle__schedule_list", "mcp__jungle__schedule_cancel",
]);

// Gmail write tools: gated through the human confirmation card when the integration's
// requireSendApproval is on, auto-allowed when the user turned that off (see preToolUseHook).
const GMAIL_READ_TOOLS = ["mcp__gmail__gmail_search", "mcp__gmail__gmail_read_message"];
const GMAIL_WRITE_TOOLS = new Set([
  "mcp__gmail__gmail_send",
  "mcp__gmail__gmail_create_draft",
  "mcp__gmail__gmail_modify_labels",
]);

// Google Drive read/write tools — same gating model as Gmail (writes honor the integration's
// requireApproval toggle in preToolUseHook; reads always run).
const DRIVE_READ_TOOLS = ["mcp__gdrive__drive_search", "mcp__gdrive__drive_list", "mcp__gdrive__drive_get_file"];
const DRIVE_WRITE_TOOLS = new Set(["mcp__gdrive__drive_create_file", "mcp__gdrive__drive_update_file"]);

// X (Twitter) tools are all read-only (Basic tier) — auto-allowed in every mode, no write gating.
const X_READ_TOOLS = [
  "mcp__x__x_my_recent_tweets",
  "mcp__x__x_mentions",
  "mcp__x__x_replies_to_me",
  "mcp__x__x_notifications",
  "mcp__x__x_search",
  "mcp__x__x_get_user",
];

// Fallback context reading derived from a `result` SDK message when the
// getContextUsage() control request is unavailable. The turn's final input
// token count (fresh + cache-read + cache-write) approximates current context
// occupancy; modelUsage carries the model's context window when present.
function contextFromResult(
  msg: unknown,
): { tokens: number; maxTokens: number } | null {
  const m = msg as {
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    modelUsage?: Record<string, { contextWindow?: number }>;
  };
  const u = m?.usage;
  if (!u) return null;
  const tokens =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0);
  if (tokens <= 0) return null;
  let maxTokens = 0;
  for (const mu of Object.values(m.modelUsage ?? {})) {
    if (typeof mu?.contextWindow === "number" && mu.contextWindow > maxTokens) {
      maxTokens = mu.contextWindow;
    }
  }
  if (maxTokens <= 0) maxTokens = 200_000; // conservative default when unknown
  return { tokens, maxTokens };
}

// True when an SDK `user` stream message carries a tool_result whose body is the CLI's
// "Stream closed" MCP-transport error — the symptom of a stale in-process MCP connection.
// That exact string only comes from a broken MCP stream (not from a tool's own output), so
// matching it is specific enough to trigger a reconnect. See runTurn's reconnect logic.
function messageHasStreamClosed(message: unknown): boolean {
  const content = (message as any)?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (c: any) =>
      c?.type === "tool_result" &&
      c?.is_error === true &&
      typeof c?.content === "string" &&
      c.content.includes("Stream closed"),
  );
}

export class Runner {
  private conn: Connection;

  // Agent working directory. /workspace in the container; overridable for
  // host testing and future sandbox providers via JUNGLE_WORKSPACE.
  private readonly workspace: string = process.env.JUNGLE_WORKSPACE ?? "/workspace";

  // Config (from `configure`; updated by set_model / set_permission_mode / set_effort).
  private model: string | null = null;
  private permissionMode: PermissionMode = "default";
  // Reasoning effort passed to query(). undefined = let the SDK/CLI use its default (the backend
  // always sends one post-migration, so this is only undefined against an old backend).
  private effort: EffortLevel | undefined = undefined;
  private systemPromptAppend = "";
  private configured = false;

  // Gmail integration state (from `configure`; token refreshed by `gmail_credentials`). null =
  // no Gmail attached. Read fresh by the gmail MCP server on each tool call, so a mid-turn refresh
  // is picked up without rebuilding the server.
  private gmailToken: string | null = null;
  private gmailSettings: { email: string; requireSendApproval: boolean } | null = null;

  // Google Drive integration state (in-process, like Gmail): settings from `configure`; the token
  // lives in integrationTokens under key "google-drive" (refreshed by `integration_credentials`).
  private driveSettings: { email: string; requireApproval: boolean } | null = null;

  // X (Twitter) integration state (in-process, read-only): settings from `configure`; the token
  // lives in integrationTokens under key "x" (refreshed by `integration_credentials`). null = no
  // X integration attached. The x MCP server reads the token live per call, so a refresh applies
  // without rebuilding.
  private xSettings: { account: string } | null = null;

  // Remote-MCP integrations (Linear/Notion/Granola/…) from `configure`: the grants (key, url,
  // safeTools, requireApproval). Access tokens for BOTH the remote-MCP integrations and the
  // in-process Drive server live in integrationTokens, keyed by integration key (seeded from the
  // configure grants, refreshed mid-session by `integration_credentials`).
  private mcpIntegrations: McpIntegrationGrant[] = [];
  private integrationTokens = new Map<string, string>();

  // Session persistence.
  private sessionId: string | null = null;

  // Turn state.
  private queue: QueueItem[] = [];
  private running = false;
  private activeQuery: Query | null = null;
  private pendingModel: string | null = null;
  // Set by a `compact` frame; consumed at the next idle boundary by running a
  // dedicated `/compact` turn. A flag (not a queue item) so it can't interleave
  // with real messages and is naturally coalesced if pressed repeatedly.
  private compactRequested = false;

  // Streaming-input generator plumbing: the running query's generator awaits this between
  // yields; deliverFollowupBatch resolves it with items (mid-turn splice) and endTurn()
  // resolves it with null (generator returns → stdin closes → query ends).
  private batchResolver: ((batch: QueueItem[] | null) => void) | null = null;

  // Close bookkeeping for the ACTIVE query (reset each runTurn): how many user messages the
  // generator has yielded vs how many `result`s the CLI has emitted. Closing the input is
  // only safe when yields <= results (see the close-rule note at the top of this file);
  // otherwise quiesceTimer closes after a silent window (a spliced message that FOLDED into
  // the running turn never gets its own result).
  private turnYields = 0;
  private turnResults = 0;
  private quiesceTimer: NodeJS.Timeout | null = null;
  private static readonly QUIESCE_MS = 3_000;

  // Long-term memory reporting: hash of the MEMORY.md content most recently sent to the
  // backend (`memory` frame), so we only report actual changes. null = nothing reported yet
  // on this process; the post-configure report seeds it.
  private lastMemoryHash: string | null = null;

  // In-flight request/response correlation.
  private pendingSendMessages = new Map<string, (r: SendMessageResult) => void>();
  private pendingReadHistory = new Map<string, (r: ReadHistoryResult) => void>();
  private pendingScheduleCreate = new Map<string, (r: ScheduleCreateResult) => void>();
  private pendingScheduleList = new Map<string, (r: ScheduleListResult) => void>();
  private pendingScheduleCancel = new Map<string, (r: ScheduleCancelResult) => void>();
  private pendingConfirms = new Map<
    string,
    (r: { allow: boolean; message?: string; updatedInput?: Record<string, unknown> }) => void
  >();

  // Backend HTTP origin for attachment transfer, derived from the WS URL.
  private readonly httpBase: string;

  constructor(private readonly env: RunnerEnv) {
    this.httpBase = httpBaseFromWsUrl(env.wsUrl);
    this.conn = new Connection(env.wsUrl, env.token, {
      onFrame: (f) => this.handleFrame(f),
      onOpen: () => this.onOpen(),
      onClose: () => this.onClose(),
    });
  }

  async start(): Promise<void> {
    const persisted = await loadState();
    this.sessionId = persisted.sessionId;
    this.model = persisted.model;
    log.info("runner starting", {
      agentId: this.env.agentId,
      sessionId: this.sessionId,
      model: this.model,
    });
    this.conn.start();
  }

  // ---- connection lifecycle ----

  private onOpen(): void {
    this.conn.send({
      type: "hello",
      agentId: this.env.agentId,
      sessionId: this.sessionId,
      protocol: PROTOCOL_VERSION,
    });
  }

  private onClose(): void {
    // Fail any in-flight confirmations: deny with "backend unreachable" so the
    // running turn doesn't hang. send_message calls will time out on their own.
    for (const [, resolve] of this.pendingConfirms) {
      resolve({ allow: false, message: "backend unreachable" });
    }
    this.pendingConfirms.clear();
    // Do not touch the queue or session: backend re-sends unacked items and we
    // reconnect with the same sessionId.
  }

  private sendState(): void {
    this.conn.send({
      type: "state",
      state: this.running ? "running" : "idle",
      sessionId: this.sessionId,
      model: this.model,
      permissionMode: this.permissionMode,
    });
  }

  // ---- frame handling ----

  private handleFrame(frame: BackendToRunner): void {
    switch (frame.type) {
      case "configure":
        void this.handleConfigure(frame);
        break;
      case "enqueue":
        this.handleEnqueue(frame.items);
        break;
      case "interrupt":
        void this.handleInterrupt();
        break;
      case "compact":
        this.handleCompact();
        break;
      case "set_permission_mode":
        void this.handleSetPermissionMode(frame.mode);
        break;
      case "set_model":
        this.handleSetModel(frame.model);
        break;
      case "set_effort":
        this.handleSetEffort(frame.effort);
        break;
      case "send_message_result": {
        const resolve = this.pendingSendMessages.get(frame.id);
        if (resolve) {
          this.pendingSendMessages.delete(frame.id);
          resolve(frame.result);
        }
        break;
      }
      case "read_history_result": {
        const resolve = this.pendingReadHistory.get(frame.id);
        if (resolve) {
          this.pendingReadHistory.delete(frame.id);
          resolve(frame.result);
        }
        break;
      }
      case "schedule_create_result": {
        const resolve = this.pendingScheduleCreate.get(frame.id);
        if (resolve) {
          this.pendingScheduleCreate.delete(frame.id);
          resolve(frame.result);
        }
        break;
      }
      case "schedule_list_result": {
        const resolve = this.pendingScheduleList.get(frame.id);
        if (resolve) {
          this.pendingScheduleList.delete(frame.id);
          resolve(frame.result);
        }
        break;
      }
      case "schedule_cancel_result": {
        const resolve = this.pendingScheduleCancel.get(frame.id);
        if (resolve) {
          this.pendingScheduleCancel.delete(frame.id);
          resolve(frame.result);
        }
        break;
      }
      case "confirm_result": {
        const resolve = this.pendingConfirms.get(frame.id);
        if (resolve) {
          this.pendingConfirms.delete(frame.id);
          resolve({
            allow: frame.result === "allow",
            message: frame.denyMessage,
            updatedInput: frame.updatedInput,
          });
        }
        break;
      }
      case "git_credentials":
        void applyGitCredentials(frame.token, frame.login);
        break;
      case "gmail_credentials":
        // A running turn's gmail server reads this via getToken on its next call — no rebuild.
        this.gmailToken = frame.accessToken;
        break;
      case "integration_credentials":
        // Fresh token for a remote-MCP integration or the in-process Drive server (keyed by
        // integration key). Remote MCP headers are fixed when query() is built, so this applies to
        // the NEXT turn; the in-process Drive server reads it live via getToken. The backend
        // refreshes before each drain so every turn starts fresh either way.
        this.integrationTokens.set(frame.key, frame.accessToken);
        break;
      default:
        log.warn("unknown frame from backend", { type: (frame as any).type });
    }
  }

  private async handleConfigure(frame: ConfigureFrame): Promise<void> {
    this.model = frame.model;
    this.permissionMode = frame.permissionMode;
    this.effort = frame.effort as EffortLevel | undefined;
    this.systemPromptAppend = frame.systemPromptAppend ?? "";
    if (frame.git) {
      // Finish repo/credential setup BEFORE allowing turns: the system prompt tells the
      // agent the repo is already in its workspace, so it must actually be there. Items
      // enqueued meanwhile just wait (maybeStartTurn no-ops until `configured`). On
      // reconnects the clone is a fast already-present check.
      await applyGitCredentials(frame.git.token, frame.git.login);
      if (frame.git.repoUrl) await cloneRepoIfNeeded(frame.git.repoUrl);
    }
    // Gmail needs no filesystem setup — just hold the token/settings; the gmail MCP server is
    // built per turn (and only when a token is present). Absent frame.gmail clears it (integration
    // removed / backing account disconnected).
    if (frame.gmail) {
      this.gmailToken = frame.gmail.accessToken;
      this.gmailSettings = { email: frame.gmail.email, requireSendApproval: frame.gmail.requireSendApproval };
    } else {
      this.gmailToken = null;
      this.gmailSettings = null;
    }
    // Remote-MCP integrations: replace the set wholesale (absent = none attached) and seed the
    // token map from each grant. Later `integration_credentials` frames update the tokens in place.
    this.mcpIntegrations = frame.mcpIntegrations ?? [];
    this.integrationTokens = new Map(this.mcpIntegrations.map((g) => [g.key, g.accessToken]));
    // Google Drive (in-process, like Gmail): hold settings + seed its token under "google-drive".
    if (frame.drive) {
      this.integrationTokens.set("google-drive", frame.drive.accessToken);
      this.driveSettings = { email: frame.drive.email, requireApproval: frame.drive.requireApproval };
    } else {
      this.driveSettings = null;
    }
    // X (in-process, read-only): hold the @handle + seed its token under "x". Built after the
    // mcpIntegrations token map is reset above so the seed isn't clobbered.
    if (frame.x) {
      this.integrationTokens.set("x", frame.x.accessToken);
      this.xSettings = { account: frame.x.account };
    } else {
      this.xSettings = null;
    }
    this.configured = true;
    void saveState({ sessionId: this.sessionId, model: this.model });
    this.sendState();
    // Report the current MEMORY.md once per (re)configure so the backend's mirror heals any
    // drift (e.g. rows migrated before memory existed, or a report lost across a disconnect).
    void this.reportMemoryIfChanged();
    this.maybeStartTurn();
  }

  private handleEnqueue(items: QueueItem[]): void {
    // Dedupe by inboxId against what's already queued (backend re-sends on reconnect).
    for (const it of items) {
      if (!this.queue.some((q) => q.inboxId === it.inboxId)) {
        this.queue.push({ inboxId: it.inboxId, text: it.text, attachments: it.attachments });
      }
    }
    log.info("enqueued items", { count: items.length, queueDepth: this.queue.length });
    // If a turn is running and the generator is awaiting a follow-up, splice the new items
    // into the live query (the CLI folds or queues them — both safe while stdin is open).
    if (this.running && this.batchResolver && this.pendingModel === null) {
      this.deliverFollowupBatch();
    } else {
      this.maybeStartTurn();
    }
  }

  private async handleInterrupt(): Promise<void> {
    if (this.activeQuery) {
      log.info("interrupting active turn");
      try {
        await this.activeQuery.interrupt();
      } catch (err) {
        log.warn("interrupt failed", { err: String(err) });
      }
    }
  }

  // Compaction request: remember it and run a dedicated `/compact` turn at the
  // next idle boundary. If a turn is already running we don't interrupt it —
  // the flag is picked up when it finishes (see the tail of runTurn).
  private handleCompact(): void {
    this.compactRequested = true;
    log.info("compact requested");
    this.maybeStartTurn();
  }

  private async handleSetPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
    log.info("set permission mode", { mode });
    if (this.activeQuery) {
      try {
        await this.activeQuery.setPermissionMode(mode);
      } catch (err) {
        log.warn("setPermissionMode failed", { err: String(err) });
      }
    }
    this.sendState();
  }

  // Effort is read fresh when each turn's query() is built, so a change applies at the next turn
  // with no query restart (unlike model, which binds the CLI subprocess). Idle: next turn. Running:
  // the turn after the current one.
  private handleSetEffort(effort: string): void {
    this.effort = effort as EffortLevel;
    log.info("set effort", { effort });
    this.sendState();
  }

  private handleSetModel(model: string): void {
    log.info("set model requested", { model });
    if (!this.running) {
      // Idle: apply immediately; next turn uses the new model.
      this.model = model;
      void saveState({ sessionId: this.sessionId, model: this.model });
      this.sendState();
    } else {
      // Running: apply at the next turn boundary by ending the current query.
      this.pendingModel = model;
      // Release any pending follow-up wait so the generator returns and query ends.
      if (this.batchResolver) {
        const resolve = this.batchResolver;
        this.batchResolver = null;
        resolve(null);
      }
    }
  }

  // ---- turn loop ----

  private maybeStartTurn(): void {
    if (this.running || !this.configured) return;
    if (this.queue.length === 0 && !this.compactRequested) return;
    void this.runTurn();
  }

  private async runTurn(): Promise<void> {
    this.running = true;

    // A compact turn runs only when there's no real work queued, so `/compact`
    // operates on a settled context and never mixes with user messages.
    const compacting = this.queue.length === 0 && this.compactRequested;
    if (compacting) this.compactRequested = false;

    // Drain the whole queue as the first batch (empty for a compact turn).
    const firstBatch = this.queue;
    this.queue = [];
    const turnId = randomUUID();
    this.turnYields = 0;
    this.turnResults = 0;

    const inboxIds = firstBatch.map((i) => i.inboxId);
    this.conn.send({ type: "turn_started", turnId, inboxIds });
    // No inbox rows back a compact turn, so nothing to ack as consumed.
    if (inboxIds.length) this.conn.send({ type: "consumed", inboxIds });
    this.sendState();

    const resumeId = await this.resumableSessionId();
    // Build a fresh in-process MCP server per turn. Each query() connects the server to its own
    // in-memory transport; the SDK's per-query cleanup closes that transport on teardown, which
    // (via the MCP Server's single-transport Protocol) nulls the server's transport binding. A
    // server SHARED across turns therefore races: the previous turn's async cleanup can null the
    // binding the current turn just established, leaving send_message with no transport — the CLI
    // then surfaces "Stream closed" to the model. A per-turn server has no cross-turn aliasing.
    const mcpServer = this.buildJungleServer();
    // Attach the gmail server only when a Gmail integration is connected. Read/search tools are
    // auto-allowed; write tools are auto-allowed only when the user turned approval off — otherwise
    // they're left off allowedTools so they route through the confirmation card (preToolUseHook).
    const gmailServer = this.gmailToken ? this.buildGmailServer() : null;
    const allowedTools = [
      "mcp__jungle__send_message",
      "mcp__jungle__read_history",
      "mcp__jungle__schedule_create",
      "mcp__jungle__schedule_list",
      "mcp__jungle__schedule_cancel",
    ];
    if (gmailServer) {
      allowedTools.push(...GMAIL_READ_TOOLS);
      if (this.gmailSettings && !this.gmailSettings.requireSendApproval) {
        allowedTools.push(...GMAIL_WRITE_TOOLS);
      }
    }
    // Google Drive: in-process server (like Gmail). Read tools auto-allowed; write tools auto-
    // allowed only when the approval toggle is off, else routed through the confirmation card.
    const driveServer = this.driveSettings ? this.buildDriveServer() : null;
    if (driveServer) {
      allowedTools.push(...DRIVE_READ_TOOLS);
      if (!this.driveSettings!.requireApproval) allowedTools.push(...DRIVE_WRITE_TOOLS);
    }
    // X: in-process, read-only server. All tools auto-allowed (nothing to approve).
    const xServer = this.xSettings ? this.buildXServer() : null;
    if (xServer) allowedTools.push(...X_READ_TOOLS);
    // Mount each connected remote-MCP integration as a remote HTTP server with a Bearer header
    // built from the current token. Read-only (safe) tools are auto-allowed; when the agent's
    // approval toggle is off, allow all of that server's tools; otherwise non-safe tools route
    // through the confirmation card (preToolUseHook honors this in every permission mode).
    const mcpServers: Record<string, McpServerConfig> = { jungle: mcpServer };
    if (gmailServer) mcpServers.gmail = gmailServer;
    if (driveServer) mcpServers.gdrive = driveServer;
    if (xServer) mcpServers.x = xServer;
    for (const grant of this.mcpIntegrations) {
      const token = this.integrationTokens.get(grant.key) ?? grant.accessToken;
      mcpServers[grant.key] = { type: "http", url: grant.url, headers: { Authorization: `Bearer ${token}` } };
      allowedTools.push(...grant.safeTools);
      if (!grant.requireApproval) allowedTools.push(`mcp__${grant.key}__*`);
    }
    // Inject the agent's memory INDEX into this turn's system prompt (fresh each turn, so
    // edits made last turn apply immediately). Linked memory files are Read on demand.
    const memoryIndex = await this.readMemoryIndex();
    const systemAppend =
      this.systemPromptAppend +
      (memoryIndex
        ? `\n\n— Your memory index (current MEMORY.md; Read linked memory files when relevant) —\n${memoryIndex}`
        : "");
    const q = query({
      prompt: this.makeInputGenerator(firstBatch, turnId, compacting),
      options: {
        cwd: this.workspace,
        model: this.model ?? undefined,
        effort: this.effort,
        permissionMode: this.permissionMode,
        resume: resumeId ?? undefined,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: systemAppend || undefined,
        },
        mcpServers,
        allowedTools,
        // A PreToolUse hook returning permissionDecision "ask" is required to
        // route tool calls to canUseTool: in the non-interactive SDK, `default`
        // mode otherwise auto-approves built-in tools and the callback never
        // fires. We only force "ask" in prompting modes; in acceptEdits /
        // bypassPermissions / dontAsk we defer to the SDK's native mode
        // behavior. send_message is always let through (auto-allowed).
        hooks: {
          PreToolUse: [{ hooks: [(input) => this.preToolUseHook(input)] }],
        },
        canUseTool: (toolName, input, opts) => this.handleCanUseTool(toolName, input, opts),
        env: this.childEnv(),
      },
    });
    this.activeQuery = q;

    let ok = true;
    let error: string | undefined;
    // A mid-turn session re-init leaves the CLI's client connection to our in-process
    // "jungle" SDK-MCP server stale: send_message then fails INSTANTLY with "Stream closed"
    // for the rest of the query, while CLI-native tools (Bash, Read) keep working. Two known
    // triggers: context compaction (announced by a `compact_boundary` event) and launching an
    // async Agent/Task subagent. We reconnect the server in place (no query restart, so the
    // model keeps its context) — proactively on `compact_boundary`, and reactively whenever a
    // tool result comes back "Stream closed" (covers the subagent case and any other cause).
    // `reconnecting` serializes overlapping triggers so the model's rapid retries don't fire a
    // storm of reconnects. `init` fires once per streamed user message, so it is NOT a re-init
    // signal and must not be used as one.
    let reconnecting = false;
    const reconnectJungle = async () => {
      if (reconnecting) return;
      reconnecting = true;
      await this.reconnectJungleMcp(q);
      reconnecting = false;
    };
    try {
      for await (const message of q) {
        // Forward every SDK stream message verbatim.
        this.conn.send({ type: "event", turnId, event: message });

        // Stream activity while the quiescence window is armed: a new turn's activity
        // (init/assistant/user — the CLI dequeued a spliced follow-up) cancels the window
        // outright — that turn's own result re-runs the close rule, and a long tool call's
        // event gaps must never fire a mid-turn close. Anything else (stray system events
        // trailing the result) just pushes the window out.
        if (this.quiesceTimer) {
          const t = (message as any).type;
          if (t === "assistant" || t === "user" || ((message as any).subtype === "init" && t === "system")) {
            clearTimeout(this.quiesceTimer);
            this.quiesceTimer = null;
          } else {
            this.armQuiesceTimer();
          }
        }

        if ((message as any).type === "system" && (message as any).subtype === "compact_boundary") {
          await reconnectJungle();
        } else if ((message as any).type === "user" && messageHasStreamClosed(message)) {
          await reconnectJungle();
        }

        if ((message as any).type === "result") {
          this.turnResults++;
          const sid = (message as any).session_id;
          if (typeof sid === "string" && sid.length > 0 && sid !== this.sessionId) {
            this.sessionId = sid;
            void saveState({ sessionId: this.sessionId, model: this.model });
          }
          const subtype = (message as any).subtype;
          if (typeof subtype === "string" && subtype.startsWith("error")) {
            ok = false;
            error = subtype;
          }
          // Report context occupancy while the query is still alive (a control
          // request needs the subprocess up — it exits once this loop ends).
          await this.reportContextUsage(q, message);
          // A `result` ended one turn of model work. Close the streaming input only when it
          // is SAFE — closing while a spliced follow-up turn is still queued runs that turn
          // with dead hook/MCP wiring (see the close-rule note at the top of this file).
          // yields <= results ⇒ nothing outstanding ⇒ close now (the common no-splice case).
          // yields > results ⇒ a spliced message either QUEUED (its turn's events will land
          // within ms — the armed timer gets pushed out and its own result re-runs this) or
          // FOLDED into the turn that just ended (no further events — the window elapses and
          // closes). Without closing here the generator would hold the stream open forever —
          // subprocess stays alive, `running` never clears, the agent is stuck "working".
          if (this.turnResults >= this.turnYields) this.endTurn();
          else this.armQuiesceTimer();
        }
      }
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : String(err);
      log.error("turn errored", { turnId, err: error });
    } finally {
      this.activeQuery = null;
      this.batchResolver = null;
      this.running = false;
      if (this.quiesceTimer) {
        clearTimeout(this.quiesceTimer);
        this.quiesceTimer = null;
      }
    }

    this.conn.send({ type: "turn_done", turnId, ok, error });

    // If the turn changed MEMORY.md, mirror it to the backend (profile panel's Memory section).
    // After turn_done so a slow read can't delay the idle transition; best-effort by design.
    void this.reportMemoryIfChanged();

    // Apply a pending model change now (at the turn boundary).
    if (this.pendingModel !== null) {
      this.model = this.pendingModel;
      this.pendingModel = null;
      void saveState({ sessionId: this.sessionId, model: this.model });
      log.info("applied pending model change", { model: this.model });
    }

    this.sendState();
    // Loop: if more work queued (or a model change left items behind), start again.
    this.maybeStartTurn();
  }

  // Build the in-process "jungle" SDK-MCP server (send_message, read_history, schedule_*), wired
  // to this runner's backend bridges. A fresh instance is used per turn and per reconnect — each
  // query() binds a server to its own transport, so instances must not be shared across connections.
  private buildJungleServer() {
    return createJungleMcpServer({
      sendMessage: (id, input) => this.bridgeSendMessage(id, input),
      uploadFile: (filePath) => uploadFile(this.httpBase, this.env.token, this.workspace, filePath),
      readHistory: (id, input) => this.bridgeReadHistory(id, input),
      scheduleCreate: (id, input) => this.bridgeScheduleCreate(id, input),
      scheduleList: (id) => this.bridgeScheduleList(id),
      scheduleCancel: (id, input) => this.bridgeScheduleCancel(id, input),
    });
  }

  // The in-process "gmail" SDK-MCP server (gmail_search/read/send/draft/modify), reading the
  // current OAuth access token fresh on each call so a mid-turn `gmail_credentials` refresh applies
  // without a rebuild. Built per turn (and per reconnect) alongside the jungle server.
  private buildGmailServer() {
    return createGmailMcpServer(() => this.gmailToken);
  }

  // The in-process "gdrive" SDK-MCP server (drive_*), reading the current OAuth access token fresh
  // on each call (integrationTokens["google-drive"]) so a mid-turn `integration_credentials`
  // refresh applies without a rebuild. Built per turn alongside the jungle/gmail servers.
  private buildDriveServer() {
    return createDriveMcpServer(() => this.integrationTokens.get("google-drive") ?? null);
  }

  // The in-process "x" SDK-MCP server (x_*), reading the current OAuth access token fresh on each
  // call (integrationTokens["x"]) so a mid-turn `integration_credentials` refresh applies without
  // a rebuild. Built per turn alongside the jungle/gmail/gdrive servers.
  private buildXServer() {
    return createXMcpServer(() => this.integrationTokens.get("x") ?? null);
  }

  // Rebuild the CLI's connection to our in-process "jungle" SDK-MCP server after a mid-turn
  // session re-init (see the reconnect comment in runTurn). reconnectMcpServer() rejects for
  // in-process (sdk) servers, so we cycle setMcpServers instead: removing 'jungle' tears down the
  // stale transport on both sides, then re-adding a fresh instance makes the CLI drop and
  // re-initialize its client — restoring send_message without restarting the query (the model
  // keeps its context). Best-effort: harmless when the connection was already healthy, and a
  // failure here must never break the turn.
  private async reconnectJungleMcp(q: Query): Promise<void> {
    try {
      const servers: Record<string, McpServerConfig> = {
        jungle: this.buildJungleServer(),
      };
      if (this.gmailToken) servers.gmail = this.buildGmailServer();
      if (this.driveSettings) servers.gdrive = this.buildDriveServer();
      if (this.xSettings) servers.x = this.buildXServer();
      // Re-mount remote-MCP integrations too, with the current token per key.
      for (const grant of this.mcpIntegrations) {
        const token = this.integrationTokens.get(grant.key) ?? grant.accessToken;
        servers[grant.key] = { type: "http", url: grant.url, headers: { Authorization: `Bearer ${token}` } };
      }
      await q.setMcpServers({});
      await q.setMcpServers(servers);
      log.info("rebuilt MCP connections after mid-turn session re-init");
    } catch (err) {
      log.warn("failed to rebuild jungle MCP connection", { err: String(err) });
    }
  }

  // The remote-MCP grant a tool call belongs to, if any. Tool names are mcp__<key>__<tool>; match
  // by the fully-qualified prefix so keys/tools containing underscores or hyphens are handled.
  private remoteMcpGrantFor(toolName: string): McpIntegrationGrant | null {
    return this.mcpIntegrations.find((g) => toolName.startsWith(`mcp__${g.key}__`)) ?? null;
  }

  // After a turn's result, tell the backend how full the context window is.
  // Prefer the SDK's getContextUsage() (counts system prompt, tools, MCP, memory,
  // and messages); fall back to the result message's own usage if that control
  // request fails. Best-effort — never let it break the turn.
  private async reportContextUsage(q: Query, resultMessage: unknown): Promise<void> {
    let tokens = 0;
    let maxTokens = 0;
    try {
      const u = await q.getContextUsage();
      if (u && typeof u.totalTokens === "number" && typeof u.maxTokens === "number") {
        tokens = u.totalTokens;
        maxTokens = u.maxTokens;
      }
    } catch (err) {
      log.warn("getContextUsage failed; using result usage", { err: String(err) });
    }
    if (tokens <= 0 || maxTokens <= 0) {
      const fb = contextFromResult(resultMessage);
      if (!fb) return;
      tokens = fb.tokens;
      maxTokens = fb.maxTokens;
    }
    if (maxTokens <= 0) return;
    const percent = Math.min(100, Math.max(0, Math.round((tokens / maxTokens) * 100)));
    this.conn.send({ type: "context_usage", tokens, maxTokens, percent });
  }

  // Emit a synthetic "jungle_inbound" event through the existing event-frame path (the same
  // one that carries SDK stream messages), so the backend persists it into agent_events and
  // broadcasts it exactly like any other turn event — no protocol/backend changes needed. This
  // is what lets the Activity transcript show what actually fed the agent: the message that
  // woke it, a mid-turn inbox delivery, or a `/compact`.
  private sendInboundEvent(turnId: string, source: "trigger" | "inbox" | "compact", text: string): void {
    this.conn.send({ type: "event", turnId, event: { type: "jungle_inbound", source, text } });
  }

  // Streaming-input generator. Yields the first batch (or `/compact`), then loops: awaiting
  // either a spliced follow-up batch (yielded into the live query — the CLI folds it into the
  // running turn or queues it as the next one) or null from endTurn() / a model change, which
  // makes the generator return so stdin closes and the query ends. turnYields counts every
  // user message handed to the CLI — the close rule in runTurn compares it against results.
  private async *makeInputGenerator(
    firstBatch: QueueItem[],
    turnId: string,
    compacting = false,
  ): AsyncGenerator<SDKUserMessage> {
    // A compact turn's only input is the `/compact` slash command; the CLI runs
    // compaction, emits a compact_boundary + result, and the query ends.
    if (compacting) {
      this.sendInboundEvent(turnId, "compact", "/compact");
      this.turnYields++;
      yield {
        type: "user",
        message: { role: "user", content: "/compact" },
        parent_tool_use_id: null,
      } as SDKUserMessage;
    } else {
      const first = await this.toUserMessageAndNotify(firstBatch, turnId, "trigger");
      this.turnYields++;
      yield first;
    }

    while (true) {
      // If a model change is pending, end the query so it can restart with the new model.
      if (this.pendingModel !== null) return;

      const batch = await new Promise<QueueItem[] | null>((resolve) => {
        this.batchResolver = resolve;
        // Items that arrived while we were yielding (batchResolver momentarily unset) —
        // deliver them now.
        if (this.queue.length > 0 && this.pendingModel === null) {
          this.batchResolver = null;
          const items = this.queue;
          this.queue = [];
          this.conn.send({ type: "consumed", inboxIds: items.map((i) => i.inboxId) });
          resolve(items);
        }
      });

      if (batch === null || batch.length === 0) return;
      const msg = await this.toUserMessageAndNotify(batch, turnId, "inbox");
      this.turnYields++;
      yield msg;
    }
  }

  // End the streaming-input query by resolving the awaited batch with null so
  // makeInputGenerator returns, stdin closes, the CLI subprocess finishes, and runTurn falls
  // through to turn_done + state:idle. ONLY safe when no spliced turn is still pending in the
  // CLI — callers go through the close rule in runTurn's result branch (or the quiescence
  // window), never directly on enqueue. No-op while the generator is mid-yield (batchResolver
  // unset); the close rule re-fires at the next result.
  private endTurn(): void {
    if (!this.batchResolver) return;
    if (this.quiesceTimer) {
      clearTimeout(this.quiesceTimer);
      this.quiesceTimer = null;
    }
    const resolve = this.batchResolver;
    this.batchResolver = null;
    resolve(null);
  }

  // Arm (or re-arm) the quiescence window: yields > results at a `result` means a spliced
  // message is unaccounted for — either its turn is about to start (an init/assistant/user
  // event cancels this) or it folded into the turn that just ended (silence: this fires and
  // closes the query).
  private armQuiesceTimer(): void {
    if (this.quiesceTimer) clearTimeout(this.quiesceTimer);
    this.quiesceTimer = setTimeout(() => {
      this.quiesceTimer = null;
      log.info("quiescence window elapsed — closing input", {
        yields: this.turnYields,
        results: this.turnResults,
      });
      this.endTurn();
    }, Runner.QUIESCE_MS);
    this.quiesceTimer.unref?.();
  }

  // Splice newly-arrived items into the live query: resolve the generator's pending await so
  // it yields them as a follow-up user message on the CLI's stdin. The CLI folds them into
  // the running turn or queues them as the next turn — both fully wired (hooks, MCP) as long
  // as stdin stays open, which the close rule guarantees.
  private deliverFollowupBatch(): void {
    if (!this.batchResolver) return;
    const items = this.queue;
    this.queue = [];
    const resolve = this.batchResolver;
    this.batchResolver = null;
    this.conn.send({ type: "consumed", inboxIds: items.map((i) => i.inboxId) });
    resolve(items);
  }

  // Build one user message from a batch. Items with attachments have their files downloaded
  // into /workspace/attachments/ first (so the agent's tools can operate on them), the text
  // notes the saved paths, and small images additionally ride along as image content blocks
  // so the model can SEE them without a tool call.
  private async toUserMessage(batch: QueueItem[]): Promise<SDKUserMessage> {
    const texts: string[] = [];
    const imageBlocks: Array<{
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }> = [];
    for (const item of batch) {
      let text = item.text;
      if (item.attachments?.length) {
        const saved = await downloadAttachments(
          this.httpBase,
          this.workspace,
          item.inboxId,
          item.attachments,
        );
        const lines = saved.map((s) =>
          s.ok
            ? `- ${s.localPath} (${s.mime})`
            : `- ${s.filename}: DOWNLOAD FAILED (${s.error})`,
        );
        text += `\n\n[Attached files, saved into your workspace]\n${lines.join("\n")}`;
        for (const s of saved) {
          if (inlineableImage(s) && imageBlocks.length < 8) {
            imageBlocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: s.mime,
                data: s.bytes!.toString("base64"),
              },
            });
          }
        }
      }
      texts.push(text);
    }
    const combined =
      texts.length === 1
        ? texts[0]
        : `You received ${texts.length} messages:\n\n` +
          texts.map((t, i) => `${i + 1}. ${t}`).join("\n\n");
    const content = imageBlocks.length
      ? [{ type: "text" as const, text: combined }, ...imageBlocks]
      : combined;
    return {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  }

  // toUserMessage, plus a jungle_inbound event carrying the same text so the Activity
  // transcript can show what fed this turn (the trigger, or a mid-turn inbox delivery).
  private async toUserMessageAndNotify(
    batch: QueueItem[],
    turnId: string,
    source: "trigger" | "inbox",
  ): Promise<SDKUserMessage> {
    const msg = await this.toUserMessage(batch);
    const content = msg.message.content;
    const text =
      typeof content === "string"
        ? content
        : ((content.find((b) => b.type === "text") as { text?: string } | undefined)?.text ?? "");
    this.sendInboundEvent(turnId, source, text);
    return msg;
  }

  // ---- PreToolUse hook: force prompting modes through canUseTool ----

  private async preToolUseHook(input: {
    hook_event_name: string;
    tool_name?: string;
    tool_input?: unknown;
  }): Promise<{
    continue?: boolean;
    hookSpecificOutput?: {
      hookEventName: "PreToolUse";
      permissionDecision?: "allow" | "deny" | "ask" | "defer";
    };
  }> {
    // Always let the auto-allowed send_message tool through untouched.
    if (input.tool_name === "mcp__jungle__send_message") return { continue: true };
    // Writes to the agent's own MEMORY.md never need a human: memory upkeep is expected,
    // bounded behavior (the system prompt asks for it), and a confirm card on every remembered
    // fact would train agents (and users) to stop using memory at all.
    if (
      (input.tool_name === "Write" || input.tool_name === "Edit") &&
      this.isMemoryPath((input.tool_input as { file_path?: unknown } | undefined)?.file_path)
    ) {
      return { continue: true };
    }
    // Gmail write tools honor the integration's explicit send-approval toggle, independent of the
    // agent's permission mode: gated (ask) when requireSendApproval is on, auto-allowed when off.
    if (GMAIL_WRITE_TOOLS.has(input.tool_name ?? "")) {
      if (!this.gmailSettings?.requireSendApproval) return { continue: true };
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } };
    }
    // Google Drive write tools honor the integration's approval toggle in every permission mode.
    if (DRIVE_WRITE_TOOLS.has(input.tool_name ?? "")) {
      if (!this.driveSettings?.requireApproval) return { continue: true };
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } };
    }
    // Remote-MCP integration tools honor their per-agent approval toggle in EVERY permission mode:
    // read-only (safe) tools run freely; other tools ask when approval is on, run when it's off.
    const grant = this.remoteMcpGrantFor(input.tool_name ?? "");
    if (grant) {
      if (grant.safeTools.includes(input.tool_name ?? "")) return { continue: true };
      if (!grant.requireApproval) return { continue: true };
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } };
    }
    // In default mode, ask a human only for tools that can change something. Read-only and
    // SDK-internal tools (ToolSearch loads MCP schemas, TodoWrite is bookkeeping, …) run
    // freely — a confirmation card for "ToolSearch" is meaningless noise to users.
    if (this.permissionMode === "default" && !SAFE_TOOLS.has(input.tool_name ?? "")) {
      return {
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
      };
    }
    // plan mode natively routes file-edit/shell-write tools to canUseTool; acceptEdits /
    // bypassPermissions / dontAsk keep their native semantics too.
    return { continue: true };
  }

  // ---- canUseTool -> confirm_request/confirm_result ----

  private handleCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    opts: { suggestions?: unknown },
  ): Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  > {
    if (!this.conn.isOpen) {
      return Promise.resolve({ behavior: "deny", message: "backend unreachable" });
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pendingConfirms.set(id, (r) => {
        if (r.allow) {
          resolve({ behavior: "allow", updatedInput: r.updatedInput ?? input });
        } else {
          resolve({ behavior: "deny", message: r.message ?? "denied" });
        }
      });
      const sent = this.conn.send({
        type: "confirm_request",
        id,
        toolName,
        input,
        suggestions: opts.suggestions,
      });
      if (!sent) {
        this.pendingConfirms.delete(id);
        resolve({ behavior: "deny", message: "backend unreachable" });
      }
    });
  }

  // ---- send_message bridge ----

  private bridgeSendMessage(
    id: string,
    input: {
      to: string;
      body: string;
      attachmentIds?: string[];
      threadRootId?: string | null;
      alsoToChannel?: boolean;
    },
  ): Promise<SendMessageResult> {
    return new Promise((resolve) => {
      this.pendingSendMessages.set(id, resolve);
      const sent = this.conn.send({ type: "send_message", id, input });
      if (!sent) {
        this.pendingSendMessages.delete(id);
        resolve({ ok: false, error: "backend unreachable" });
      }
      // The tool handler applies a 60s timeout; if it fires we clean up here too.
      setTimeout(() => {
        if (this.pendingSendMessages.delete(id)) {
          resolve({ ok: false, error: "timed out waiting for backend" });
        }
      }, 60_000).unref?.();
    });
  }

  // ---- read_history bridge ----

  private bridgeReadHistory(
    id: string,
    input: { to: string; threadRootId?: string; beforeSeq?: string; limit?: number },
  ): Promise<ReadHistoryResult> {
    return new Promise((resolve) => {
      this.pendingReadHistory.set(id, resolve);
      const sent = this.conn.send({ type: "read_history", id, input });
      if (!sent) {
        this.pendingReadHistory.delete(id);
        resolve({ ok: false, error: "backend unreachable" });
      }
      setTimeout(() => {
        if (this.pendingReadHistory.delete(id)) {
          resolve({ ok: false, error: "timed out waiting for backend" });
        }
      }, 60_000).unref?.();
    });
  }

  // ---- schedule_* bridges ----

  private bridgeScheduleCreate(
    id: string,
    input: { prompt: string; cron?: string; timezone?: string; runAt?: string; channel?: string },
  ): Promise<ScheduleCreateResult> {
    return new Promise((resolve) => {
      this.pendingScheduleCreate.set(id, resolve);
      const sent = this.conn.send({ type: "schedule_create", id, input });
      if (!sent) {
        this.pendingScheduleCreate.delete(id);
        resolve({ ok: false, error: "backend unreachable" });
      }
      setTimeout(() => {
        if (this.pendingScheduleCreate.delete(id)) {
          resolve({ ok: false, error: "timed out waiting for backend" });
        }
      }, 60_000).unref?.();
    });
  }

  private bridgeScheduleList(id: string): Promise<ScheduleListResult> {
    return new Promise((resolve) => {
      this.pendingScheduleList.set(id, resolve);
      const sent = this.conn.send({ type: "schedule_list", id, input: {} });
      if (!sent) {
        this.pendingScheduleList.delete(id);
        resolve({ ok: false, error: "backend unreachable" });
      }
      setTimeout(() => {
        if (this.pendingScheduleList.delete(id)) {
          resolve({ ok: false, error: "timed out waiting for backend" });
        }
      }, 60_000).unref?.();
    });
  }

  private bridgeScheduleCancel(
    id: string,
    input: { scheduleId: string },
  ): Promise<ScheduleCancelResult> {
    return new Promise((resolve) => {
      this.pendingScheduleCancel.set(id, resolve);
      const sent = this.conn.send({ type: "schedule_cancel", id, input });
      if (!sent) {
        this.pendingScheduleCancel.delete(id);
        resolve({ ok: false, error: "backend unreachable" });
      }
      setTimeout(() => {
        if (this.pendingScheduleCancel.delete(id)) {
          resolve({ ok: false, error: "timed out waiting for backend" });
        }
      }, 60_000).unref?.();
    });
  }

  private childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    // Don't leak runner plumbing into the agent's child processes. NODE_ENV especially:
    // "production" makes `npm install` silently skip devDependencies in agent workspaces.
    delete env.NODE_ENV;
    delete env.JUNGLE_RUNNER_TOKEN;
    delete env.JUNGLE_BACKEND_WS;
    // Keep Claude Code state (session JSONL transcripts) on the workspace volume so the
    // agent's memory survives container recreation (image upgrades, config changes).
    env.CLAUDE_CONFIG_DIR = path.join(this.workspace, ".claude");
    const gh = getGhToken();
    if (gh) env.GH_TOKEN = gh;
    return env;
  }

  // ---- long-term memory ----
  //
  // Agents use Claude Code's NATIVE memory system: a directory of markdown files (one per
  // durable fact) indexed by a MEMORY.md, living under CLAUDE_CONFIG_DIR/projects/<slug>/memory
  // — which is on the workspace volume (childEnv sets CLAUDE_CONFIG_DIR=<workspace>/.claude),
  // so it survives machine recreation. The claude_code system-prompt preset already teaches the
  // model this format and location; steering it to a different bespoke file was observed to
  // lose against the preset's trained-in convention. The runner's roles are: (1) auto-allow
  // writes inside the memory dir (preToolUseHook) so memory upkeep never hits a confirm card,
  // (2) inject the INDEX into each turn's system prompt so what the agent knows is
  // deterministic (linked files are Read on demand — Read is a safe tool), and (3) mirror
  // index+files to the backend for the profile panel's read-only Memory section.

  private memoryDir(): string {
    // Same project-dir slug convention as resumableSessionId (CLAUDE_CONFIG_DIR layout).
    const slug = this.workspace.replace(/[^a-zA-Z0-9]/g, "-");
    return path.join(this.workspace, ".claude", "projects", slug, "memory");
  }

  // A plain fallback file some agents may write anyway (and the location our system prompt
  // mentions as equivalent); treated as part of memory for allowlisting + injection + mirror.
  private legacyMemoryPath(): string {
    return path.join(this.workspace, "MEMORY.md");
  }

  // Does a tool call's file_path target the agent's memory (native dir or fallback file)?
  // Resolved against the workspace so relative and absolute paths both match.
  private isMemoryPath(filePath: unknown): boolean {
    if (typeof filePath !== "string" || !filePath) return false;
    const resolved = path.resolve(this.workspace, filePath);
    return (
      resolved === this.legacyMemoryPath() ||
      resolved === this.memoryDir() ||
      resolved.startsWith(this.memoryDir() + path.sep)
    );
  }

  // Injection cap: the index rides in every turn's system prompt, so a runaway file can't be
  // allowed to eat the context window.
  private static readonly MEMORY_INDEX_MAX_CHARS = 8_000;
  // Mirror cap: index + all memory files, for the profile viewer (backend clamps again).
  private static readonly MEMORY_MIRROR_MAX_CHARS = 32_000;

  private async readFileTrimmed(p: string): Promise<string | null> {
    try {
      const raw = (await fs.readFile(p, "utf8")).trim();
      return raw || null;
    } catch {
      return null;
    }
  }

  // The memory INDEX injected into each turn's system prompt: the native dir's MEMORY.md,
  // plus the fallback /workspace/MEMORY.md if an agent used that instead.
  private async readMemoryIndex(): Promise<string | null> {
    const parts: string[] = [];
    const native = await this.readFileTrimmed(path.join(this.memoryDir(), "MEMORY.md"));
    if (native) parts.push(native);
    const legacy = await this.readFileTrimmed(this.legacyMemoryPath());
    if (legacy) parts.push(legacy);
    if (!parts.length) return null;
    const joined = parts.join("\n\n");
    return joined.length <= Runner.MEMORY_INDEX_MAX_CHARS
      ? joined
      : joined.slice(0, Runner.MEMORY_INDEX_MAX_CHARS) +
          "\n\n[memory index truncated — prune MEMORY.md down]";
  }

  // Everything for the backend mirror: the index first, then each memory file under the
  // native dir (alphabetical), each with a filename heading so the viewer reads naturally.
  private async readMemoryMirror(): Promise<string> {
    const parts: string[] = [];
    const index = await this.readMemoryIndex();
    if (index) parts.push(index);
    try {
      const entries = (await fs.readdir(this.memoryDir())).filter(
        (f) => f.endsWith(".md") && f !== "MEMORY.md",
      );
      entries.sort();
      for (const f of entries) {
        const body = await this.readFileTrimmed(path.join(this.memoryDir(), f));
        if (body) parts.push(`---\n**${f}**\n\n${body}`);
      }
    } catch {
      // no memory dir yet — index (or nothing) is the whole mirror
    }
    return parts.join("\n\n").slice(0, Runner.MEMORY_MIRROR_MAX_CHARS);
  }

  // Mirror memory to the backend when it changed since the last report ("" = absent/empty, so
  // wiped memory clears the backend copy too). Best-effort: never throws, and the hash is only
  // advanced on a successful send so a dropped frame is retried at the next boundary.
  private async reportMemoryIfChanged(): Promise<void> {
    try {
      const content = await this.readMemoryMirror();
      const hash = createHash("sha256").update(content).digest("hex");
      if (hash === this.lastMemoryHash) return;
      if (this.conn.send({ type: "memory", content })) this.lastMemoryHash = hash;
    } catch (err) {
      log.warn("memory report failed", { err: String(err) });
    }
  }

  // Only pass `resume` when the session transcript actually exists — a stale sessionId
  // (container recreated before CLAUDE_CONFIG_DIR lived on the volume, transcript pruned,
  // …) would otherwise make every turn fail at startup. Falls back to a fresh session.
  private async resumableSessionId(): Promise<string | null> {
    if (!this.sessionId) return null;
    const slug = this.workspace.replace(/[^a-zA-Z0-9]/g, "-"); // Claude Code project-dir slug
    const file = path.join(this.workspace, ".claude", "projects", slug, `${this.sessionId}.jsonl`);
    try {
      await fs.access(file);
      return this.sessionId;
    } catch {
      log.warn("session transcript missing; starting fresh session", { sessionId: this.sessionId });
      this.sessionId = null;
      void saveState({ sessionId: null, model: this.model });
      return null;
    }
  }

  fatal(error: string): void {
    this.conn.send({ type: "fatal", error });
  }
}
