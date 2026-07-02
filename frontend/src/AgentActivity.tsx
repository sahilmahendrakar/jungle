import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAgentEvents,
  interruptAgent,
  type AgentEvent,
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
import { avatarClass, initials } from "@/lib/people";
import { cn } from "@/lib/utils";
import {
  Activity as ActivityIcon,
  ChevronRight,
  SendHorizonal,
  Square,
} from "lucide-react";

type RunnerState = "idle" | "running";

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

// Live status dot: connected/running/idle. Muted when the runner is offline.
function StatusDot({
  connected,
  state,
}: {
  connected: boolean;
  state: RunnerState;
}) {
  const running = connected && state === "running";
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={cn(
          "size-2 rounded-full",
          !connected
            ? "bg-muted-foreground/40"
            : running
              ? "animate-pulse bg-emerald-500"
              : "bg-emerald-500/60",
        )}
      />
      {!connected ? "Offline" : running ? "Running" : "Idle"}
    </span>
  );
}

// A collapsible disclosure row for JSON-ish detail (tool input, tool result, unknown events).
function Collapsible({
  summary,
  children,
  defaultOpen = false,
  testId,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="min-w-0">
      <button
        type="button"
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-1 rounded text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </button>
      {open && <div className="ml-4.5 mt-1">{children}</div>}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-lg border bg-muted/40 p-2 text-[11px] leading-relaxed">
      {pretty(value)}
    </pre>
  );
}

// Render one SDK content block from an assistant message.
function AssistantBlock({ block }: { block: any }) {
  if (block?.type === "text") {
    return (
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
        {String(block.text ?? "")}
      </p>
    );
  }
  if (block?.type === "thinking") {
    return (
      <Collapsible summary={<span className="italic">Thinking</span>}>
        <p className="whitespace-pre-wrap break-words text-xs italic leading-relaxed text-muted-foreground">
          {String(block.thinking ?? "")}
        </p>
      </Collapsible>
    );
  }
  if (block?.type === "tool_use") {
    return (
      <Collapsible
        testId="activity-tool-use"
        summary={
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden>⚙</span>
            <span className="font-medium text-foreground">{String(block.name ?? "tool")}</span>
          </span>
        }
      >
        <JsonBlock value={block.input ?? {}} />
      </Collapsible>
    );
  }
  return <JsonBlock value={block} />;
}

// Render a tool_result block from a user message.
function ToolResultBlock({ block }: { block: any }) {
  const content = block?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((c: any) => (typeof c === "string" ? c : c?.text ?? pretty(c)))
            .join("\n")
        : pretty(content);
  const isError = block?.is_error === true;
  const oneLine = text.split("\n")[0]?.slice(0, 80) ?? "result";
  return (
    <Collapsible
      summary={
        <span className={cn("truncate", isError && "text-destructive")}>
          ↳ {isError ? "error" : "result"}: {oneLine}
        </span>
      }
    >
      <pre
        className={cn(
          "max-h-72 overflow-auto rounded-lg border bg-muted/40 p-2 text-[11px] leading-relaxed",
          isError && "border-destructive/40 text-destructive",
        )}
      >
        {text}
      </pre>
    </Collapsible>
  );
}

// Render a single persisted event by its SDK message type. Defensive: unknown -> JSON row.
function EventRow({ event }: { event: unknown }) {
  const ev = event as any;
  const type = ev?.type;

  if (type === "system") {
    return (
      <div className="text-xs text-muted-foreground">
        Session started{ev?.subtype ? ` · ${ev.subtype}` : ""}
      </div>
    );
  }

  if (type === "assistant") {
    const blocks: any[] = ev?.message?.content ?? [];
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return <JsonBlock value={event} />;
    }
    return (
      <div className="space-y-1.5">
        {blocks.map((b, i) => (
          <AssistantBlock key={i} block={b} />
        ))}
      </div>
    );
  }

  if (type === "user") {
    const blocks: any[] = ev?.message?.content ?? [];
    const results = Array.isArray(blocks)
      ? blocks.filter((b) => b?.type === "tool_result")
      : [];
    if (results.length === 0) return <JsonBlock value={event} />;
    return (
      <div className="space-y-1.5">
        {results.map((b, i) => (
          <ToolResultBlock key={i} block={b} />
        ))}
      </div>
    );
  }

  if (type === "result") {
    const bits: string[] = [];
    if (typeof ev?.duration_ms === "number") bits.push(`${(ev.duration_ms / 1000).toFixed(1)}s`);
    if (typeof ev?.total_cost_usd === "number") bits.push(`$${ev.total_cost_usd.toFixed(4)}`);
    if (ev?.subtype && ev.subtype !== "success") bits.push(String(ev.subtype));
    return (
      <div className="text-xs text-muted-foreground">
        Turn complete{bits.length ? ` · ${bits.join(" · ")}` : ""}
      </div>
    );
  }

  // Unknown shape — render collapsed.
  return (
    <Collapsible summary={<span className="font-mono text-xs">{String(type ?? "event")}</span>}>
      <JsonBlock value={event} />
    </Collapsible>
  );
}

// A collapsible turn section. Newest turn defaults to expanded.
function TurnSection({ turn, defaultOpen }: { turn: Turn; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  // Keep the newest turn expanding as new events stream in.
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);

  const result = turn.events.find((e) => (e.event as any)?.type === "result");
  const startedAt = turn.events[0]?.created_at;

  return (
    <div data-testid="activity-turn" className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <span className="text-xs font-semibold text-muted-foreground">
          Turn
        </span>
        <span className="text-xs text-muted-foreground">
          {startedAt ? new Date(startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}
        </span>
        {!result && (
          <span className="ml-auto flex items-center gap-1 text-[11px] font-medium text-emerald-600">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> running
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-2.5 border-t px-3 py-2.5">
          {turn.events.map((e) => (
            <EventRow key={e.id} event={e.event} />
          ))}
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
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<RunnerState>("idle");
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
        setConnected(page.runner.connected);
        setState(page.runner.state);
        setHasMore(page.events.length >= 200);
      })
      .catch((e) => !cancelled && setErr(String((e as Error).message ?? e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [agent.id, isSdk]);

  // Live events flip the runner to "running"; a `result` event flips it back to "idle".
  useEffect(() => {
    if (events.length === 0) return;
    setConnected(true);
    const last = events[events.length - 1];
    const type = (last.event as any)?.type;
    setState(type === "result" ? "idle" : "running");
  }, [events]);

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
      else setState("idle");
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

  const running = connected && state === "running";
  const empty = !loading && turns.length === 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        data-testid="agent-activity"
        className="flex h-[85vh] max-h-[85vh] w-[92vw] max-w-3xl flex-col gap-0 overflow-hidden p-0"
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
                  <StatusDot connected={connected} state={state} />
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
                <TurnSection key={t.turnId} turn={t} defaultOpen={i === turns.length - 1} />
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
