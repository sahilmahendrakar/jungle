import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAgentEvents,
  interruptAgent,
  type AgentEvent,
  type AgentStatus,
  type Participant,
} from "./api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Markdown } from "./Markdown";
import { avatarClass, initials } from "@/lib/people";
import { cn } from "@/lib/utils";
import {
  Activity as ActivityIcon,
  Bot,
  Check,
  ChevronRight,
  FilePen,
  FilePlus2,
  FileText,
  Globe,
  Loader2,
  MessageSquare,
  Search,
  SendHorizonal,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

// Merge event pages / live frames by id, keeping ascending (oldest-first) order.
function mergeEvents(a: AgentEvent[], b: AgentEvent[]): AgentEvent[] {
  const map = new Map<number, AgentEvent>();
  for (const e of [...a, ...b]) map.set(e.id, e);
  return [...map.values()].sort((x, y) => x.id - y.id);
}

// Group ascending events into turns (turn_id), preserving first-seen order.
interface Turn {
  turnId: string;
  events: AgentEvent[];
}
function groupTurns(events: AgentEvent[]): Turn[] {
  const out: Turn[] = [];
  const byId = new Map<string, Turn>();
  for (const e of events) {
    const key = e.turn_id ?? "—";
    let t = byId.get(key);
    if (!t) {
      t = { turnId: key, events: [] };
      byId.set(key, t);
      out.push(t);
    }
    t.events.push(e);
  }
  return out;
}

function pretty(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// Live status dot for the four agent statuses (mirrors the sidebar's colors/labels).
const STATUS_DOT: Record<AgentStatus, string> = {
  working: "animate-pulse bg-emerald-500",
  idle: "bg-emerald-500/60",
  waking: "animate-pulse bg-amber-400",
  sleeping: "bg-slate-400/70",
};
const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Working",
  idle: "Idle",
  waking: "Waking up",
  sleeping: "Sleeping",
};
function StatusDot({ status }: { status: AgentStatus }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-2 rounded-full", STATUS_DOT[status])} />
      {STATUS_LABEL[status]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Item model: a turn's raw SDK events flattened into renderable items.
// Tool calls are paired with their tool_result (by tool_use_id) so each call
// renders as a single row with a live status, Claude Code style.
// ---------------------------------------------------------------------------

interface ToolResultInfo {
  text: string;
  isError: boolean;
}
interface ToolItem {
  kind: "tool";
  key: string;
  name: string;
  input: any;
  result: ToolResultInfo | null;
}
interface TextItem {
  kind: "text";
  key: string;
  text: string;
}
interface ThinkingItem {
  kind: "thinking";
  key: string;
  text: string;
}
interface NoteItem {
  kind: "note";
  key: string;
  text: string;
}
interface ResultItem {
  kind: "result";
  key: string;
  ok: boolean;
  text?: string;
  durationMs?: number;
  cost?: number;
}
interface RawItem {
  kind: "raw";
  key: string;
  value: unknown;
}
type Item = ToolItem | TextItem | ThinkingItem | NoteItem | ResultItem | RawItem;

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c: any) => (typeof c === "string" ? c : (c?.text ?? pretty(c))))
      .join("\n");
  return pretty(content);
}

// System subtypes that are pure noise in a human transcript.
const HIDDEN_SYSTEM = new Set(["thinking_tokens", "task_progress", "task_updated"]);

function buildItems(events: AgentEvent[]): Item[] {
  const items: Item[] = [];
  const byToolUseId = new Map<string, ToolItem>();
  for (const e of events) {
    const ev = e.event as any;
    const type = ev?.type;

    if (type === "system") {
      const st = String(ev?.subtype ?? "");
      if (HIDDEN_SYSTEM.has(st)) continue;
      if (st === "init") items.push({ kind: "note", key: `${e.id}`, text: "Session started" });
      else if (st === "task_started")
        items.push({
          kind: "note",
          key: `${e.id}`,
          text: `Background task started${ev?.description ? ` — ${ev.description}` : ""}`,
        });
      else if (st === "task_notification")
        items.push({
          kind: "note",
          key: `${e.id}`,
          text: `Background task ${ev?.status ?? "update"}${ev?.summary ? ` — ${ev.summary}` : ""}`,
        });
      else items.push({ kind: "note", key: `${e.id}`, text: st || "system" });
      continue;
    }

    if (type === "assistant") {
      const blocks = ev?.message?.content;
      if (!Array.isArray(blocks)) {
        items.push({ kind: "raw", key: `${e.id}`, value: ev });
        continue;
      }
      blocks.forEach((b: any, i: number) => {
        const key = `${e.id}:${i}`;
        if (b?.type === "text") {
          const text = String(b.text ?? "");
          if (text.trim()) items.push({ kind: "text", key, text });
        } else if (b?.type === "thinking") {
          const text = String(b.thinking ?? "");
          if (text.trim()) items.push({ kind: "thinking", key, text });
        } else if (b?.type === "tool_use") {
          const t: ToolItem = {
            kind: "tool",
            key,
            name: String(b.name ?? "tool"),
            input: b.input ?? {},
            result: null,
          };
          items.push(t);
          if (b.id) byToolUseId.set(String(b.id), t);
        } else {
          items.push({ kind: "raw", key, value: b });
        }
      });
      continue;
    }

    if (type === "user") {
      const blocks = ev?.message?.content;
      if (Array.isArray(blocks)) {
        blocks.forEach((b: any, i: number) => {
          if (b?.type !== "tool_result") return;
          const res: ToolResultInfo = {
            text: resultText(b.content),
            isError: b.is_error === true,
          };
          const t = b.tool_use_id ? byToolUseId.get(String(b.tool_use_id)) : undefined;
          if (t) t.result = res;
          else
            items.push({
              kind: "tool",
              key: `${e.id}:${i}`,
              name: "tool",
              input: null,
              result: res,
            });
        });
      }
      continue;
    }

    if (type === "result") {
      items.push({
        kind: "result",
        key: `${e.id}`,
        ok: ev?.is_error !== true && (ev?.subtype ?? "success") === "success",
        text: typeof ev?.result === "string" ? ev.result : undefined,
        durationMs: typeof ev?.duration_ms === "number" ? ev.duration_ms : undefined,
        cost: typeof ev?.total_cost_usd === "number" ? ev.total_cost_usd : undefined,
      });
      continue;
    }

    items.push({ kind: "raw", key: `${e.id}`, value: ev });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Tool call presentation: human verb + target per tool, Claude Code style.
// ---------------------------------------------------------------------------

interface ToolMeta {
  icon: LucideIcon;
  verb: string;
  target?: string;
  mono?: boolean; // render target in monospace
}

function baseName(p: unknown): string {
  const s = String(p ?? "");
  const ix = s.lastIndexOf("/");
  return ix >= 0 ? s.slice(ix + 1) : s;
}

function firstString(input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const v of Object.values(input)) if (typeof v === "string" && v.trim()) return v;
  return undefined;
}

function toolMeta(name: string, input: any): ToolMeta {
  switch (name) {
    case "Bash":
      return {
        icon: Terminal,
        verb: "Ran",
        target: String(input?.description ?? input?.command ?? ""),
        mono: !input?.description,
      };
    case "Read":
      return { icon: FileText, verb: "Read", target: baseName(input?.file_path), mono: true };
    case "Edit":
      return { icon: FilePen, verb: "Edited", target: baseName(input?.file_path), mono: true };
    case "Write":
      return { icon: FilePlus2, verb: "Wrote", target: baseName(input?.file_path), mono: true };
    case "Grep":
      return { icon: Search, verb: "Searched", target: String(input?.pattern ?? ""), mono: true };
    case "Glob":
      return { icon: Search, verb: "Found files", target: String(input?.pattern ?? ""), mono: true };
    case "ToolSearch":
      return { icon: Search, verb: "Searched tools", target: String(input?.query ?? "") };
    case "WebFetch":
      return { icon: Globe, verb: "Fetched", target: String(input?.url ?? ""), mono: true };
    case "WebSearch":
      return { icon: Globe, verb: "Searched web", target: String(input?.query ?? "") };
    case "Task":
    case "Agent":
      return { icon: Bot, verb: "Ran subagent", target: String(input?.description ?? "") };
    case "TodoWrite":
      return { icon: Check, verb: "Updated to-dos" };
  }
  // MCP tools look like mcp__server__tool_name.
  const mcp = name.match(/^mcp__([^_].*?)__(.+)$/);
  if (mcp) {
    const label = mcp[2].replace(/_/g, " ");
    const verb = label.charAt(0).toUpperCase() + label.slice(1);
    if (mcp[2] === "send_message")
      return { icon: MessageSquare, verb: "Sent message", target: firstString(input) };
    return { icon: Wrench, verb, target: firstString(input) };
  }
  return { icon: Wrench, verb: name, target: firstString(input) };
}

const CLIP = 96;
function clip(s: string | undefined): string {
  if (!s) return "";
  const line = s.split("\n")[0];
  return line.length > CLIP ? `${line.slice(0, CLIP)}…` : line;
}

function OutputBlock({ text, isError }: { text: string; isError: boolean }) {
  return (
    <pre
      className={cn(
        "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed",
        isError && "border-destructive/40 bg-destructive/5 text-destructive",
      )}
    >
      {text}
    </pre>
  );
}

// Expanded detail for one tool call: tool-specific input rendering + output.
function ToolDetail({ item }: { item: ToolItem }) {
  const { name, input, result } = item;
  return (
    <div className="mt-1 space-y-1.5">
      {name === "Bash" && typeof input?.command === "string" ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-zinc-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-zinc-100">
          <span className="select-none text-zinc-500">$ </span>
          {input.command}
        </pre>
      ) : name === "Edit" &&
        typeof input?.old_string === "string" &&
        typeof input?.new_string === "string" ? (
        <div className="overflow-hidden rounded-md border font-mono text-[11px] leading-relaxed">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-b bg-red-500/10 px-2.5 py-1.5 text-red-700 dark:text-red-400">
            {input.old_string}
          </pre>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words bg-emerald-500/10 px-2.5 py-1.5 text-emerald-700 dark:text-emerald-400">
            {input.new_string}
          </pre>
        </div>
      ) : name === "Write" && typeof input?.content === "string" ? (
        <OutputBlock text={input.content} isError={false} />
      ) : input && Object.keys(input).length > 0 ? (
        <OutputBlock text={pretty(input)} isError={false} />
      ) : null}
      {result && result.text.trim() && (
        <OutputBlock text={result.text} isError={result.isError} />
      )}
    </div>
  );
}

// One tool call as a compact row: icon + verb + target + status; click to expand.
function ToolRow({ item, turnDone }: { item: ToolItem; turnDone: boolean }) {
  const [open, setOpen] = useState(false);
  const meta = toolMeta(item.name, item.input);
  const Icon = meta.icon;
  const pending = !item.result && !turnDone;
  return (
    <div className="min-w-0">
      <button
        type="button"
        data-testid="activity-tool-use"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/60"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px]">
          <span className="font-medium text-foreground/90">{meta.verb}</span>
          {meta.target && (
            <span
              className={cn(
                "ml-1.5 text-muted-foreground",
                meta.mono && "font-mono text-xs",
              )}
            >
              {clip(meta.target)}
            </span>
          )}
        </span>
        <span className="ml-2 flex shrink-0 items-center">
          {pending ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          ) : item.result?.isError ? (
            <X className="size-3.5 text-destructive" />
          ) : item.result ? (
            <Check className="size-3.5 text-emerald-600" />
          ) : (
            <span className="text-[10px] text-muted-foreground/60">—</span>
          )}
        </span>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform group-hover:text-muted-foreground",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="ml-7 min-w-0">
          <ToolDetail item={item} />
        </div>
      )}
    </div>
  );
}

// Collapsed-by-default reasoning row.
function ThinkingRow({ item }: { item: ThinkingItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/60"
      >
        <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px] italic text-muted-foreground">
          Thought{open ? "" : ` — ${clip(item.text)}`}
        </span>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform group-hover:text-muted-foreground",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <p className="ml-7 mt-1 whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-xs italic leading-relaxed text-muted-foreground">
          {item.text}
        </p>
      )}
    </div>
  );
}

function RawRow({ item }: { item: RawItem }) {
  const [open, setOpen] = useState(false);
  const label = String((item.value as any)?.type ?? "event");
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-muted-foreground transition-colors hover:bg-muted/60"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{label}</span>
      </button>
      {open && (
        <div className="ml-7 mt-1">
          <OutputBlock text={pretty(item.value)} isError={false} />
        </div>
      )}
    </div>
  );
}

function ItemRow({ item, turnDone }: { item: Item; turnDone: boolean }) {
  switch (item.kind) {
    case "text":
      return (
        <div className="px-2 py-1">
          <Markdown>{item.text}</Markdown>
        </div>
      );
    case "thinking":
      return <ThinkingRow item={item} />;
    case "tool":
      return <ToolRow item={item} turnDone={turnDone} />;
    case "note":
      return (
        <div className="px-2 py-0.5 text-xs text-muted-foreground/80">{item.text}</div>
      );
    case "result":
      return (
        <div
          className={cn(
            "flex items-center gap-1.5 px-2 py-0.5 text-xs",
            item.ok ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {item.ok ? <Check className="size-3" /> : <X className="size-3" />}
          <span>
            {item.ok ? "Done" : (clip(item.text) || "Failed")}
            {item.durationMs != null && ` · ${(item.durationMs / 1000).toFixed(1)}s`}
            {item.cost != null && ` · $${item.cost.toFixed(item.cost >= 1 ? 2 : 4)}`}
          </span>
        </div>
      );
    case "raw":
      return <RawRow item={item} />;
  }
}

// Short scannable summary for a collapsed turn header.
function turnSummary(items: Item[]): string {
  const lastText = [...items].reverse().find((i) => i.kind === "text") as TextItem | undefined;
  if (lastText) return clip(lastText.text.replace(/[#*`>]/g, "").trim());
  const tools = items.filter((i) => i.kind === "tool").length;
  if (tools > 0) return `${tools} action${tools === 1 ? "" : "s"}`;
  const note = items.find((i) => i.kind === "note") as NoteItem | undefined;
  return note?.text ?? "";
}

// A collapsible turn section. Newest turn defaults to expanded.
function TurnSection({
  turn,
  defaultOpen,
  running,
}: {
  turn: Turn;
  defaultOpen: boolean;
  running: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Keep the newest turn expanding as new events stream in.
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  const items = useMemo(() => buildItems(turn.events), [turn.events]);
  const result = items.find((i) => i.kind === "result") as ResultItem | undefined;
  const turnDone = result != null;
  const active = !turnDone && running;
  const startedAt = turn.events[0]?.created_at;

  return (
    <div data-testid="activity-turn" className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {startedAt
            ? new Date(startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
            : ""}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-foreground/80">
          {turnSummary(items)}
        </span>
        {active ? (
          <span className="ml-2 flex shrink-0 items-center gap-1 text-[11px] font-medium text-emerald-600">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> running
          </span>
        ) : result && !result.ok ? (
          <X className="ml-2 size-3.5 shrink-0 text-destructive" />
        ) : result?.durationMs != null ? (
          <span className="ml-2 shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {(result.durationMs / 1000).toFixed(1)}s
          </span>
        ) : null}
      </button>
      {open && (
        <div className="space-y-0.5 border-t px-2 py-2">
          {items.map((it) => (
            <ItemRow key={it.key} item={it} turnDone={turnDone} />
          ))}
          {active && (
            <div className="flex items-center gap-2 px-2 py-1 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Working…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentActivity({
  agent,
  events,
  onClose,
  onSteer,
}: {
  agent: Participant;
  // Live-merged events for this agent, oldest-first, owned by the parent (buffered while open).
  events: AgentEvent[];
  onClose: () => void;
  // Send a normal DM to the agent (flows through the inbox to the next turn boundary).
  onSteer: (agent: Participant, body: string) => Promise<void>;
}) {
  const isSdk = agent.runtime === "sdk";
  const [history, setHistory] = useState<AgentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [err, setErr] = useState("");
  const [steer, setSteer] = useState("");
  const [stopping, setStopping] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true); // is the user scrolled to the bottom?

  // All events = history page(s) + live buffer, deduped and ordered.
  const all = useMemo(() => mergeEvents(history, events), [history, events]);
  const turns = useMemo(() => groupTurns(all), [all]);

  // Initial load.
  useEffect(() => {
    if (!isSdk) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchAgentEvents(agent.id, { limit: 200 })
      .then((page) => {
        if (cancelled) return;
        setHistory(page.events);
        setHasMore(page.events.length >= 200);
      })
      .catch((e) => !cancelled && setErr(String((e as Error).message ?? e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [agent.id, isSdk]);

  const loadEarlier = useCallback(async () => {
    if (loadingMore || !hasMore || all.length === 0) return;
    setLoadingMore(true);
    const vp = viewportRef.current;
    const prevHeight = vp?.scrollHeight ?? 0;
    try {
      const smallest = all[0].id;
      const page = await fetchAgentEvents(agent.id, { before: smallest, limit: 200 });
      setHistory((h) => mergeEvents(page.events, h));
      setHasMore(page.events.length >= 200);
      // Preserve scroll position after prepending.
      requestAnimationFrame(() => {
        if (vp) vp.scrollTop = vp.scrollHeight - prevHeight;
      });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setLoadingMore(false);
    }
  }, [agent.id, all, hasMore, loadingMore]);

  // Track whether the user is pinned to the bottom.
  const onScroll = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    pinnedRef.current = vp.scrollHeight - vp.scrollTop - vp.clientHeight < 40;
  }, []);

  // Auto-scroll to bottom on new content, but only while pinned.
  useEffect(() => {
    const vp = viewportRef.current;
    if (vp && pinnedRef.current) vp.scrollTop = vp.scrollHeight;
  }, [all.length, loading]);

  async function stop() {
    if (stopping) return;
    setStopping(true);
    setErr("");
    try {
      const r = await interruptAgent(agent.id);
      if (!r.ok) setErr(r.error ?? "failed to stop agent");
      // On success the runner's turn_done/state broadcast flips agent.status back to idle.
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setStopping(false);
    }
  }

  async function sendSteer() {
    const body = steer.trim();
    if (!body) return;
    setSteer("");
    try {
      await onSteer(agent, body);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  const status: AgentStatus = agent.status ?? "idle";
  const running = status === "working";
  const empty = !loading && turns.length === 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        data-testid="agent-activity"
        className={cn(
          // Mobile: full-screen sheet (no rounded corners, edge-to-edge).
          "flex h-screen-dvh max-h-none w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0",
          // Desktop: centered panel.
          "md:h-[85vh] md:max-h-[85vh] md:w-[92vw] md:max-w-3xl md:rounded-xl md:border",
        )}
      >
        {/* Header: identity + status + stop */}
        <DialogHeader className="flex flex-row items-center gap-3 border-b px-4 py-3">
          <Avatar className="size-9 rounded-md">
            <AvatarFallback className={cn(avatarClass(agent.handle), "rounded-md text-xs")}>
              {initials(agent.display_name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex items-center gap-2 text-base">
              <span className="truncate">{agent.display_name}</span>
              <ActivityIcon className="size-4 shrink-0 text-muted-foreground" />
            </DialogTitle>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">@{agent.handle}</span>
              {isSdk && (
                <>
                  <span aria-hidden>·</span>
                  <StatusDot status={status} />
                </>
              )}
            </div>
          </div>
          {isSdk && running && (
            <Button
              data-testid="activity-stop"
              variant="destructive"
              size="sm"
              onClick={stop}
              disabled={stopping}
              className="mr-8 h-8 gap-1.5"
            >
              <Square className="size-3.5" />
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          )}
        </DialogHeader>

        {/* Transcript */}
        <div
          ref={viewportRef}
          onScroll={onScroll}
          data-testid="activity-transcript"
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        >
          {!isSdk || empty ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
                <ActivityIcon className="size-6 text-muted-foreground" />
              </div>
              <p className="max-w-xs text-sm text-muted-foreground">
                Activity appears here when this agent starts working.
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {hasMore && (
                <div className="flex justify-center pb-1">
                  <Button
                    data-testid="activity-load-earlier"
                    variant="ghost"
                    size="sm"
                    onClick={loadEarlier}
                    disabled={loadingMore}
                    className="h-7 text-xs text-muted-foreground"
                  >
                    {loadingMore ? "Loading…" : "Load earlier"}
                  </Button>
                </div>
              )}
              {loading && (
                <div className="py-6 text-center text-sm text-muted-foreground">Loading…</div>
              )}
              {turns.map((t, i) => (
                <TurnSection
                  key={t.turnId}
                  turn={t}
                  defaultOpen={i === turns.length - 1}
                  running={running && i === turns.length - 1}
                />
              ))}
            </div>
          )}
        </div>

        {err && (
          <div className="mx-4 mb-1 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive">
            {err}
          </div>
        )}

        {/* Steering footer */}
        {isSdk && (
          <div className="border-t p-3">
            <div className="flex items-end gap-2 rounded-xl border bg-card p-2 shadow-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20">
              <Input
                data-testid="activity-steer-input"
                value={steer}
                onChange={(e) => setSteer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendSteer();
                  }
                }}
                placeholder={`Message @${agent.handle}…`}
                className="border-0 bg-transparent shadow-none focus-visible:ring-0"
              />
              <Button
                data-testid="activity-steer-send"
                onClick={sendSteer}
                size="icon"
                className="shrink-0"
                aria-label="Send message"
              >
                <SendHorizonal className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
