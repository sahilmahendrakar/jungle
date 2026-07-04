import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAgentEvents, type AgentEvent, type Participant } from "../../api";
import { Button } from "@/components/ui/button";
import { Activity as ActivityIcon } from "lucide-react";
import { groupTurns, mergeEvents } from "./activity/sdkEvents";
import { TurnSection } from "./activity/Transcript";

// The scrollable, paginated turn-by-turn transcript shared by the full-screen Activity dialog
// (AgentActivity) and the inline "View activity" mode in an agent DM (DmActivityView) — same
// data loading/scroll-pin/load-earlier behavior, just without a header or steer footer around it.
export function ActivityTranscript({
  agent,
  events,
  running,
}: {
  agent: Participant;
  // Live-merged events for this agent, oldest-first, owned by the parent (buffered while open).
  events: AgentEvent[];
  running: boolean;
}) {
  const isSdk = agent.runtime === "sdk";
  const [history, setHistory] = useState<AgentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [err, setErr] = useState("");

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

  const empty = !loading && turns.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
    </div>
  );
}
