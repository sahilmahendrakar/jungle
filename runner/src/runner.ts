// Core runner: bridges a Claude Agent SDK session to the Jungle backend.
//
// Turn loop:
//   - queue holds {inboxId, text}. When idle and queue non-empty, drain ALL
//     queued items as one batch, emit turn_started + consumed, and run one
//     streaming query() whose generator yields the batch as a single user
//     message. While the query runs, if more items arrive AND no model change
//     is pending, the generator yields them as a follow-up user message right
//     away: the SDK's streamInput() pulls the next generator value and writes
//     it to the CLI's stdin as soon as it's available, with no wait for a
//     `result`/turn-end event, so a follow-up is spliced into the live session
//     mid-turn, not batched until the current turn finishes. If nothing is
//     queued when a `result` arrives, the generator returns, the query ends,
//     and the loop restarts (also used to apply a pending model change via
//     query restart with resume).
import {
  query,
  type EffortLevel,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "./log.js";
import { Connection } from "./connection.js";
import {
  createJungleMcpServer,
  type SendMessageResult,
  type ReadHistoryResult,
} from "./send-message-tool.js";
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
]);

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

  // Streaming-input generator plumbing: the running query's generator awaits
  // `nextBatch`; we resolve it with a batch (follow-up turn) or null (end query).
  private batchResolver: ((batch: QueueItem[] | null) => void) | null = null;

  // In-flight request/response correlation.
  private pendingSendMessages = new Map<string, (r: SendMessageResult) => void>();
  private pendingReadHistory = new Map<string, (r: ReadHistoryResult) => void>();
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
    this.configured = true;
    void saveState({ sessionId: this.sessionId, model: this.model });
    this.sendState();
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
    // If a turn is running and there's a pending follow-up request, satisfy it.
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
    const mcpServer = createJungleMcpServer(
      (id, input) => this.bridgeSendMessage(id, input),
      (filePath) => uploadFile(this.httpBase, this.env.token, this.workspace, filePath),
      (id, input) => this.bridgeReadHistory(id, input),
    );
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
          append: this.systemPromptAppend || undefined,
        },
        mcpServers: { jungle: mcpServer },
        allowedTools: ["mcp__jungle__send_message", "mcp__jungle__read_history"],
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
    try {
      for await (const message of q) {
        // Forward every SDK stream message verbatim.
        this.conn.send({ type: "event", turnId, event: message });

        if ((message as any).type === "result") {
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
          // The `result` ends this turn's model work. Any follow-up that arrived while the
          // turn was running was already streamed into the generator by handleEnqueue the
          // moment it was enqueued (see deliverFollowupBatch) — this check only decides
          // whether to keep the query alive. If nothing is queued, close the streaming input
          // so the query completes, the CLI subprocess exits, and runTurn falls through to
          // turn_done + idle. Without this the generator would await the next batch forever —
          // subprocess stays alive, `running` never clears, and the agent is stuck "working"
          // (idle-stop never fires).
          this.endTurnIfQuiescent();
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
    }

    this.conn.send({ type: "turn_done", turnId, ok, error });

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

  // Streaming-input generator. Yields the first batch, then awaits follow-up
  // batches at each turn boundary until told to stop (null).
  private async *makeInputGenerator(
    firstBatch: QueueItem[],
    turnId: string,
    compacting = false,
  ): AsyncGenerator<SDKUserMessage> {
    // A compact turn's only input is the `/compact` slash command; the CLI runs
    // compaction, emits a compact_boundary + result, and the query ends.
    if (compacting) {
      this.sendInboundEvent(turnId, "compact", "/compact");
      yield {
        type: "user",
        message: { role: "user", content: "/compact" },
        parent_tool_use_id: null,
      } as SDKUserMessage;
    } else {
      yield await this.toUserMessageAndNotify(firstBatch, turnId, "trigger");
    }

    while (true) {
      // If a model change is pending, end the query so it can restart with the new model.
      if (this.pendingModel !== null) return;

      const batch = await new Promise<QueueItem[] | null>((resolve) => {
        this.batchResolver = resolve;
        // If items arrived after we drained but before we set the resolver, deliver now.
        if (this.queue.length > 0 && this.pendingModel === null) {
          this.batchResolver = null;
          const items = this.queue;
          this.queue = [];
          this.conn.send({ type: "consumed", inboxIds: items.map((i) => i.inboxId) });
          resolve(items);
        }
      });

      if (batch === null || batch.length === 0) return;
      yield await this.toUserMessageAndNotify(batch, turnId, "inbox");
    }
  }

  // Called after a `result`: end the streaming-input query if there's nothing more to feed
  // it, by resolving the awaited batch with null so makeInputGenerator returns, the CLI
  // subprocess exits, and runTurn falls through to turn_done + state:idle. No-op when a
  // follow-up batch was already delivered mid-turn (batchResolver consumed by
  // deliverFollowupBatch before this ever runs) or a model change is pending (handleSetModel
  // already ended the query to restart with the new model).
  private endTurnIfQuiescent(): void {
    if (!this.batchResolver) return;
    if (this.pendingModel !== null) return;
    if (this.queue.length > 0) return;
    const resolve = this.batchResolver;
    this.batchResolver = null;
    resolve(null);
  }

  // Called when items arrive while a turn is running and a follow-up is awaited: resolves
  // makeInputGenerator's pending promise immediately, so the generator yields the new batch
  // and the SDK's streamInput() writes it straight to the CLI's stdin — spliced into the live
  // session mid-turn, without waiting for the current turn's `result`.
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
  }): Promise<{
    continue?: boolean;
    hookSpecificOutput?: {
      hookEventName: "PreToolUse";
      permissionDecision?: "allow" | "deny" | "ask" | "defer";
    };
  }> {
    // Always let the auto-allowed send_message tool through untouched.
    if (input.tool_name === "mcp__jungle__send_message") return { continue: true };
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
