import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  FilePen,
  FilePlus2,
  FileText,
  Globe,
  Inbox,
  Loader2,
  MessageSquare,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { Markdown } from "../../../Markdown";
import { cn } from "@/lib/utils";
import {
  baseName,
  buildItems,
  clip,
  firstString,
  inputField,
  inputStr,
  pretty,
  turnSummary,
  type InboundItem,
  type Item,
  type RawItem,
  type ResultItem,
  type ThinkingItem,
  type ToolItem,
  type Turn,
} from "./sdkEvents";

// ---- Tool call presentation: human verb + target per tool, Claude Code style ----

interface ToolMeta {
  icon: LucideIcon;
  verb: string;
  target?: string;
  mono?: boolean; // render target in monospace
}

function toolMeta(name: string, input: unknown): ToolMeta {
  switch (name) {
    case "Bash":
      return {
        icon: Terminal,
        verb: "Ran",
        target: inputField(input, "description") ?? inputStr(input, "command"),
        mono: !inputField(input, "description"),
      };
    case "Read":
      return { icon: FileText, verb: "Read", target: baseName(inputStr(input, "file_path")), mono: true };
    case "Edit":
      return { icon: FilePen, verb: "Edited", target: baseName(inputStr(input, "file_path")), mono: true };
    case "Write":
      return { icon: FilePlus2, verb: "Wrote", target: baseName(inputStr(input, "file_path")), mono: true };
    case "Grep":
      return { icon: Search, verb: "Searched", target: inputStr(input, "pattern"), mono: true };
    case "Glob":
      return { icon: Search, verb: "Found files", target: inputStr(input, "pattern"), mono: true };
    case "ToolSearch":
      return { icon: Search, verb: "Searched tools", target: inputStr(input, "query") };
    case "WebFetch":
      return { icon: Globe, verb: "Fetched", target: inputStr(input, "url"), mono: true };
    case "WebSearch":
      return { icon: Globe, verb: "Searched web", target: inputStr(input, "query") };
    case "Task":
    case "Agent":
      return { icon: Bot, verb: "Ran subagent", target: inputStr(input, "description") };
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
  const command = inputField(input, "command");
  const oldStr = inputField(input, "old_string");
  const newStr = inputField(input, "new_string");
  const content = inputField(input, "content");
  const hasInput = !!input && typeof input === "object" && Object.keys(input).length > 0;
  return (
    <div className="mt-1 space-y-1.5">
      {name === "Bash" && command != null ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-zinc-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-zinc-100">
          <span className="select-none text-zinc-500">$ </span>
          {command}
        </pre>
      ) : name === "Edit" && oldStr != null && newStr != null ? (
        <div className="overflow-hidden rounded-md border font-mono text-[11px] leading-relaxed">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-b bg-red-500/10 px-2.5 py-1.5 text-red-700 dark:text-red-400">
            {oldStr}
          </pre>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words bg-emerald-500/10 px-2.5 py-1.5 text-emerald-700 dark:text-emerald-400">
            {newStr}
          </pre>
        </div>
      ) : name === "Write" && content != null ? (
        <OutputBlock text={content} isError={false} />
      ) : hasInput ? (
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
              className={cn("ml-1.5 text-muted-foreground", meta.mono && "font-mono text-xs")}
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

const INBOUND_LABEL: Record<InboundItem["source"], string> = {
  trigger: "Woke up on",
  inbox: "Received while working",
  compact: "Compacting context",
};

// A message that fed this agent from outside its own turn: what woke it, a mid-turn inbox
// delivery, or `/compact`. Rendered distinctly from the agent's own output so it reads as
// "incoming" rather than something the agent said or did.
function InboundRow({ item }: { item: InboundItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0 rounded-md border border-dashed bg-muted/30">
      <button
        type="button"
        data-testid="activity-inbound"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/60"
      >
        <Inbox className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[13px]">
          <span className="font-medium text-foreground/90">{INBOUND_LABEL[item.source]}</span>
          {!open && item.text.trim() && (
            <span className="ml-1.5 text-muted-foreground">{clip(item.text)}</span>
          )}
        </span>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/50 transition-transform group-hover:text-muted-foreground",
            open && "rotate-90",
          )}
        />
      </button>
      {open && item.text.trim() && (
        <div className="ml-7 mr-2 mb-1.5">
          <OutputBlock text={item.text} isError={false} />
        </div>
      )}
    </div>
  );
}

function RawRow({ item }: { item: RawItem }) {
  const [open, setOpen] = useState(false);
  const label = String((item.value as { type?: string })?.type ?? "event");
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
      return <div className="px-2 py-0.5 text-xs text-muted-foreground/80">{item.text}</div>;
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
            {item.ok ? "Done" : clip(item.text) || "Failed"}
            {item.durationMs != null && ` · ${(item.durationMs / 1000).toFixed(1)}s`}
            {item.cost != null && ` · $${item.cost.toFixed(item.cost >= 1 ? 2 : 4)}`}
          </span>
        </div>
      );
    case "raw":
      return <RawRow item={item} />;
    case "inbound":
      return <InboundRow item={item} />;
  }
}

// A collapsible turn section. Newest turn defaults to expanded.
export function TurnSection({
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
