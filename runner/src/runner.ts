// Core runner: bridges a Claude Agent SDK session to the Jungle backend.
//
// Turn loop:
//   - queue holds {inboxId, text}. When idle and queue non-empty, drain ALL
//     queued items as one batch, emit turn_started + consumed, and run one
//     streaming query() whose generator yields the batch as a single user
//     message. While the query runs, if more items arrive AND no model change
//     is pending, the generator yields them as a follow-up user message at the
//     turn boundary (after the previous turn's `result`). Otherwise the
//     generator returns, the query ends, and the loop restarts (used to apply
//     a pending model change via query restart with resume).
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";
import { Connection } from "./connection.js";
import { createJungleMcpServer, type SendMessageResult } from "./send-message-tool.js";
import { applyGitCredentials, cloneRepoIfNeeded, getGhToken } from "./git.js";
import { loadState, saveState } from "./state.js";
import {
  PROTOCOL_VERSION,
  type BackendToRunner,
  type ConfigureFrame,
  type PermissionMode,
} from "./protocol.js";

interface QueueItem {
  inboxId: string;
  text: string;
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
  "ListMcpResources", "ReadMcpResource",
]);

export class Runner {
  private conn: Connection;

  // Agent working directory. /workspace in the container; overridable for
  // host testing and future sandbox providers via JUNGLE_WORKSPACE.
  private readonly workspace: string = process.env.JUNGLE_WORKSPACE ?? "/workspace";

  // Config (from `configure`; updated by set_model / set_permission_mode).
  private model: string | null = null;
  private permissionMode: PermissionMode = "default";
  private systemPromptAppend = "";
  private configured = false;

  // Session persistence.
  private sessionId: string | null = null;

  // Turn state.
  private queue: QueueItem[] = [];
  private running = false;
  private activeQuery: Query | null = null;
  private pendingModel: string | null = null;

  // Streaming-input generator plumbing: the running query's generator awaits
  // `nextBatch`; we resolve it with a batch (follow-up turn) or null (end query).
  private batchResolver: ((batch: QueueItem[] | null) => void) | null = null;

  // In-flight request/response correlation.
  private pendingSendMessages = new Map<string, (r: SendMessageResult) => void>();
  private pendingConfirms = new Map<
    string,
    (r: { allow: boolean; message?: string; updatedInput?: Record<string, unknown> }) => void
  >();

  private mcpServer: ReturnType<typeof createJungleMcpServer>;

  constructor(private readonly env: RunnerEnv) {
    this.mcpServer = createJungleMcpServer((id, input) => this.bridgeSendMessage(id, input));
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
        this.handleConfigure(frame);
        break;
      case "enqueue":
        this.handleEnqueue(frame.items);
        break;
      case "interrupt":
        void this.handleInterrupt();
        break;
      case "set_permission_mode":
        void this.handleSetPermissionMode(frame.mode);
        break;
      case "set_model":
        this.handleSetModel(frame.model);
        break;
      case "send_message_result": {
        const resolve = this.pendingSendMessages.get(frame.id);
        if (resolve) {
          this.pendingSendMessages.delete(frame.id);
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

  private handleConfigure(frame: ConfigureFrame): void {
    this.model = frame.model;
    this.permissionMode = frame.permissionMode;
    this.systemPromptAppend = frame.systemPromptAppend ?? "";
    this.configured = true;
    if (frame.git) {
      void (async () => {
        await applyGitCredentials(frame.git!.token, frame.git!.login);
        if (frame.git!.repoUrl) await cloneRepoIfNeeded(frame.git!.repoUrl);
      })();
    }
    void saveState({ sessionId: this.sessionId, model: this.model });
    this.sendState();
    this.maybeStartTurn();
  }

  private handleEnqueue(items: Array<{ inboxId: string; text: string }>): void {
    // Dedupe by inboxId against what's already queued (backend re-sends on reconnect).
    for (const it of items) {
      if (!this.queue.some((q) => q.inboxId === it.inboxId)) {
        this.queue.push({ inboxId: it.inboxId, text: it.text });
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
    if (this.running || !this.configured || this.queue.length === 0) return;
    void this.runTurn();
  }

  private async runTurn(): Promise<void> {
    this.running = true;

    // Drain the whole queue as the first batch.
    const firstBatch = this.queue;
    this.queue = [];
    const turnId = randomUUID();

    this.conn.send({ type: "turn_started", turnId, inboxIds: firstBatch.map((i) => i.inboxId) });
    this.conn.send({ type: "consumed", inboxIds: firstBatch.map((i) => i.inboxId) });
    this.sendState();

    const q = query({
      prompt: this.makeInputGenerator(firstBatch, turnId),
      options: {
        cwd: this.workspace,
        model: this.model ?? undefined,
        permissionMode: this.permissionMode,
        resume: this.sessionId ?? undefined,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: this.systemPromptAppend || undefined,
        },
        mcpServers: { jungle: this.mcpServer },
        allowedTools: ["mcp__jungle__send_message"],
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

  // Streaming-input generator. Yields the first batch, then awaits follow-up
  // batches at each turn boundary until told to stop (null).
  private async *makeInputGenerator(
    firstBatch: QueueItem[],
    turnId: string,
  ): AsyncGenerator<SDKUserMessage> {
    yield this.toUserMessage(firstBatch);

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
      yield this.toUserMessage(batch);
    }
  }

  // Called when items arrive while a turn is running and a follow-up is awaited.
  private deliverFollowupBatch(): void {
    if (!this.batchResolver) return;
    const items = this.queue;
    this.queue = [];
    const resolve = this.batchResolver;
    this.batchResolver = null;
    this.conn.send({ type: "consumed", inboxIds: items.map((i) => i.inboxId) });
    resolve(items);
  }

  private toUserMessage(batch: QueueItem[]): SDKUserMessage {
    const content =
      batch.length === 1
        ? batch[0].text
        : `You received ${batch.length} messages:\n\n` +
          batch.map((b, i) => `${i + 1}. ${b.text}`).join("\n\n");
    return {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };
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
    input: { to: string; body: string },
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

  private childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    const gh = getGhToken();
    if (gh) env.GH_TOKEN = gh;
    return env;
  }

  fatal(error: string): void {
    this.conn.send({ type: "fatal", error });
  }
}
