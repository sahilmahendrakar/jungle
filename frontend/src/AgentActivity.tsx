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
import { avatarClass, initials } from "@/lib/people";
import { cn } from "@/lib/utils";
import { Activity as ActivityIcon, SendHorizonal, Square } from "lucide-react";
import { groupTurns, mergeEvents } from "./components/chat/activity/sdkEvents";
import { TurnSection } from "./components/chat/activity/Transcript";

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

// The agent Activity view: a Claude-Code-style live transcript (turns of raw SDK events, parsed by
// sdkEvents + rendered by Transcript's TurnSection) with paginated history, plus a steering footer
// to DM the agent. This file is the shell — data loading, scroll/pin, stop, and layout.
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
