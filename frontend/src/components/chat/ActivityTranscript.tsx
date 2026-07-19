import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAgentEvents, type AgentEvent, type Participant } from "../../api";
import { Button } from "@/components/ui/button";
import { Activity as ActivityIcon } from "lucide-react";
import { countVisibleTurns, groupTurns, mergeEvents, turnHasVisibleItems } from "./activity/sdkEvents";
import { TurnSection } from "./activity/Transcript";
import { EmptyState } from "./panels";
import { Skeleton } from "@/components/ui/skeleton";

// The scrollable, paginated turn-by-turn transcript shared by the full-screen Activity dialog
// (AgentActivity) and the inline "View activity" mode in an agent DM (DmActivityView) — same
// data loading/scroll-pin/load-earlier behavior, just without a header or steer footer around it.

// On open, auto-page backwards until the transcript shows at least this many turns — a busy turn
// emits dozens of raw SDK events, so a single 200-event page can be just a turn or two. Capped by
// AUTO_MAX_PAGES so an agent with very chatty turns doesn't pull unbounded history on every open;
// "Load earlier" remains for going further back.
const AUTO_MIN_TURNS = 12;
const AUTO_MAX_PAGES = 5;
const PAGE_SIZE = 200;

export function ActivityTranscript({
  agent,
  events,
  running,
  focusTurnId,
}: {
  agent: Participant;
  // Live-merged events for this agent, oldest-first, owned by the parent (buffered while open).
  events: AgentEvent[];
  running: boolean;
  // Open scrolled to (and expanded on) this turn instead of pinned to the newest — the
  // "view the work behind this message" entry point.
  focusTurnId?: string | null;
}) {
  const isSdk = agent.runtime === "sdk";
  const [history, setHistory] = useState<AgentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // True while the open-time auto-pagination (below) is still pulling earlier pages — shown as
  // the "Load earlier" button in its loading state so it's clear more history is on its way.
  const [autoLoading, setAutoLoading] = useState(false);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [err, setErr] = useState("");

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true); // is the user scrolled to the bottom?

  // All events = history page(s) + live buffer, deduped and ordered.
  const all = useMemo(() => mergeEvents(history, events), [history, events]);
  const turns = useMemo(() => groupTurns(all), [all]);
  // Filter out turns whose events all render as nothing (e.g. thinking_tokens/task_progress).
  const visibleTurns = useMemo(() => turns.filter(turnHasVisibleItems), [turns]);

  // Keep the same content in view when a page prepends above an unpinned (reading-up) user —
  // the pinned case is handled by the scroll-to-bottom effect.
  const preserveScrollOnPrepend = useCallback((prevHeight: number) => {
    requestAnimationFrame(() => {
      const vp = viewportRef.current;
      if (vp && !pinnedRef.current) vp.scrollTop += vp.scrollHeight - prevHeight;
    });
  }, []);

  // Initial load + open-time auto-pagination: fetch the newest page, then keep paging backwards
  // (updating the transcript as pages land) until AUTO_MIN_TURNS turns are visible, the pages are
  // exhausted, or AUTO_MAX_PAGES is hit.
  useEffect(() => {
    if (!isSdk) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        let page = await fetchAgentEvents(agent.id, { limit: PAGE_SIZE });
        if (cancelled) return;
        let acc = page.events;
        let more = page.events.length >= PAGE_SIZE;
        setHistory(acc);
        setHasMore(more);
        setLoading(false); // the first page renders while earlier pages stream in
        let pages = 1;
        while (
          more &&
          !cancelled &&
          pages < AUTO_MAX_PAGES &&
          countVisibleTurns(acc) < AUTO_MIN_TURNS
        ) {
          setAutoLoading(true);
          const prevHeight = viewportRef.current?.scrollHeight ?? 0;
          page = await fetchAgentEvents(agent.id, { before: acc[0].id, limit: PAGE_SIZE });
          if (cancelled) return;
          acc = mergeEvents(page.events, acc);
          more = page.events.length >= PAGE_SIZE;
          pages++;
          setHistory(acc);
          setHasMore(more);
          preserveScrollOnPrepend(prevHeight);
        }
      } catch (e) {
        if (!cancelled) setErr(String((e as Error).message ?? e));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setAutoLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agent.id, isSdk, preserveScrollOnPrepend]);

  const loadEarlier = useCallback(async () => {
    if (loadingMore || autoLoading || !hasMore || history.length === 0) return;
    setLoadingMore(true);
    const prevHeight = viewportRef.current?.scrollHeight ?? 0;
    // Keep paging backwards until the fetch adds at least one visible turn or history runs out.
    // A single 200-event page can be all hidden SDK noise (thinking_tokens, tool_result updates),
    // so chaining prevents the "click and nothing happens" symptom.
    let localHistory = history;
    let localHasMore: boolean = hasMore;
    try {
      let pages = 0;
      while (localHasMore && pages < AUTO_MAX_PAGES) {
        const visibleBefore = countVisibleTurns(localHistory);
        const smallest = localHistory[0].id;
        const page = await fetchAgentEvents(agent.id, { before: smallest, limit: PAGE_SIZE });
        localHistory = mergeEvents(page.events, localHistory);
        localHasMore = page.events.length >= PAGE_SIZE;
        setHistory(localHistory);
        setHasMore(localHasMore);
        pages++;
        if (countVisibleTurns(localHistory) > visibleBefore) break;
      }
      preserveScrollOnPrepend(prevHeight);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setLoadingMore(false);
    }
  }, [agent.id, hasMore, loadingMore, autoLoading, history, preserveScrollOnPrepend]);

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

  // Focused open: once loaded, scroll the focus turn into view (instead of the bottom pin).
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusTurnId || loading || focusedRef.current) return;
    const el = viewportRef.current?.querySelector(`[data-turn-id="${focusTurnId}"]`);
    if (!el) return; // may be beyond the first page — the user can "Load earlier"
    focusedRef.current = true;
    pinnedRef.current = false;
    el.scrollIntoView({ block: "start" });
  }, [focusTurnId, loading, visibleTurns.length]);

  const empty = !loading && visibleTurns.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={viewportRef}
        onScroll={onScroll}
        data-testid="activity-transcript"
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {!isSdk || empty ? (
          <div className="flex h-full flex-col justify-center">
            <EmptyState icon={<ActivityIcon className="size-6" />}>
              Activity appears here when this agent starts working.
            </EmptyState>
          </div>
        ) : (
          <div className="space-y-2.5">
            {hasMore && !loading && (
              <div className="flex justify-center pb-1">
                <Button
                  data-testid="activity-load-earlier"
                  variant="ghost"
                  size="sm"
                  onClick={loadEarlier}
                  disabled={loadingMore || autoLoading}
                  className="h-7 text-xs text-muted-foreground"
                >
                  {loadingMore || autoLoading ? "Loading…" : "Load earlier"}
                </Button>
              </div>
            )}
            {loading && (
              <div className="space-y-2.5 py-1">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            )}
            {visibleTurns.map((t, i) => (
              <TurnSection
                key={t.turnId}
                turn={t}
                defaultOpen={i === visibleTurns.length - 1 || t.turnId === focusTurnId}
                running={running && i === visibleTurns.length - 1}
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
