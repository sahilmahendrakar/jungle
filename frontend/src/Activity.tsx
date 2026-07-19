import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity as ActivityIcon,
  ArrowUp,
  AtSign,
  Hash,
  Loader2,
  MessagesSquare,
  Package,
  X,
} from "lucide-react";
import {
  listActivity,
  type ActivityFilters,
  type ActivityItem,
  type ActivityMessage,
  type Channel,
  type Participant,
} from "./api";
import { dayLabel, fmtRelative, snippet } from "./lib/chat";
import { IS_TOKENS, KIND_LABELS, KIND_TOKENS, TYPE_TOKENS, chipLabel, parseTokens, tokenAtCaret } from "./lib/filterTokens";
import { ViewShell } from "./components/chat/ViewShell";
import { DeliverableRow } from "./Deliverables";
import { PersonAvatar } from "./components/chat/panels";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The Activity page: one merged stream of everything relevant to you — your messages, DMs,
// @mentions, thread replies on your threads, and deliverables from your channels — composably
// filterable (pills for type/direction, tokens for from:/to:/in:/kind:, free text for bodies).
// Every filter lives in the URL, so a filtered view is a shareable link; clicking a message
// deep-links into its channel/thread scrolled to it (App.jumpToMessage).

const PAGE = 50;

type Direction = NonNullable<ActivityFilters["direction"]>;
type TypeFilter = ActivityFilters["type"];

// --- URL <-> filter state (deep links like /activity?type=deliverables&from=@pip) ---

function filtersFromLocation(): { filters: ActivityFilters; text: string } {
  const sp = new URLSearchParams(location.search);
  const filters: ActivityFilters = { type: "all" };
  const t = sp.get("type");
  if (t === "messages" || t === "deliverables") filters.type = t;
  const d = sp.get("direction");
  if (d === "sent" || d === "received" || d === "mentions") filters.direction = d;
  for (const key of ["from", "to", "person", "kind"] as const) {
    const v = sp.get(key);
    if (v) filters[key] = v.replace(/^@/, "").toLowerCase();
  }
  const inParam = sp.get("in");
  if (inParam?.startsWith("@")) filters.inDm = inParam.slice(1).toLowerCase();
  else if (inParam) filters.inChannel = inParam.replace(/^#/, "").toLowerCase();
  // A `q` deep link is re-tokenized so its chips render like typed ones.
  const q = sp.get("q") ?? "";
  if (q) {
    const parsed = parseTokens(q);
    Object.assign(filters, { ...parsed.filters, type: filters.type !== "all" ? filters.type : parsed.filters.type });
    return { filters, text: parsed.text };
  }
  return { filters, text: "" };
}

function filtersToSearch(filters: ActivityFilters, text: string): string {
  const sp = new URLSearchParams();
  // The dev identity param survives every in-app navigation (route.ts preserves it).
  const as = new URLSearchParams(location.search).get("as");
  if (as) sp.set("as", as);
  if (filters.type && filters.type !== "all") sp.set("type", filters.type);
  if (filters.direction) sp.set("direction", filters.direction);
  if (filters.from) sp.set("from", `@${filters.from}`);
  if (filters.to) sp.set("to", `@${filters.to}`);
  if (filters.person) sp.set("person", `@${filters.person}`);
  if (filters.inChannel) sp.set("in", `#${filters.inChannel}`);
  if (filters.inDm) sp.set("in", `@${filters.inDm}`);
  if (filters.kind) sp.set("kind", filters.kind);
  if (text) sp.set("q", text);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// --- Small filter-bar primitives ---

function Pill({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// The token input: free text with from:/to:/in:/type:/kind:/is: autocomplete. A completed token
// (recognized + trailing space) folds itself into the filters and leaves the input.
function TokenInput({
  value,
  onChange,
  onToken,
  channels,
  people,
}: {
  value: string;
  onChange: (v: string) => void;
  onToken: (filters: ActivityFilters) => void;
  channels: Channel[];
  people: Participant[];
}) {
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const active = tokenAtCaret(value, caret);
  const suggestions: { label: string; insert: string }[] = useMemo(() => {
    if (!active) return [];
    const prefix = active.value.replace(/^[@#]+/, "").toLowerCase();
    switch (active.key) {
      case "from":
      case "to":
        return people
          .filter((p) => p.handle.toLowerCase().startsWith(prefix))
          .slice(0, 6)
          .map((p) => ({ label: `@${p.handle} — ${p.display_name}`, insert: `${active.key}:@${p.handle}` }));
      case "in": {
        const rooms = channels
          .filter((c) => c.kind !== "dm" && c.name.toLowerCase().startsWith(prefix))
          .slice(0, 4)
          .map((c) => ({ label: `#${c.name}`, insert: `in:#${c.name}` }));
        const dms = active.value.startsWith("@")
          ? people
              .filter((p) => p.handle.toLowerCase().startsWith(prefix))
              .slice(0, 4)
              .map((p) => ({ label: `@${p.handle} (DM)`, insert: `in:@${p.handle}` }))
          : [];
        return [...rooms, ...dms].slice(0, 6);
      }
      case "type":
        return TYPE_TOKENS.filter((t) => t.startsWith(prefix)).map((t) => ({
          label: t === "messages" ? "messages" : "deliverables",
          insert: `type:${t}`,
        }));
      case "kind":
        return KIND_TOKENS.filter((t) => t.startsWith(prefix)).map((t) => ({
          label: `${t} — ${KIND_LABELS[t]}`,
          insert: `kind:${t}`,
        }));
      case "is":
        return IS_TOKENS.filter((t) => t.startsWith(prefix)).map((t) => ({
          label: t,
          insert: `is:${t}`,
        }));
      default:
        return [];
    }
  }, [active, people, channels]);

  useEffect(() => setIndex(0), [active?.key, active?.value]);

  function commitToken(insert: string) {
    if (!active) return;
    const next = `${value.slice(0, active.start)}${insert} ${value.slice(active.end)}`.replace(/\s+/g, " ").trimStart();
    // The inserted token is complete — fold it into the filters immediately.
    const { filters, text } = parseTokens(next);
    onToken(filters);
    onChange(text ? `${text} ` : "");
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // Fold completed tokens (recognized key:value followed by a space) into the filters as the
  // user types, so "from:@pip deploy " leaves "deploy" in the input and a chip in the bar.
  function handleChange(next: string, nextCaret: number) {
    if (next.endsWith(" ")) {
      const { filters, text } = parseTokens(next);
      const hadToken = next.trim().split(/\s+/).length > (text ? text.split(/\s+/).length : 0);
      if (hadToken) {
        onToken(filters);
        onChange(text ? `${text} ` : "");
        return;
      }
    }
    onChange(next);
    setCaret(nextCaret);
  }

  return (
    <div className="relative min-w-0 flex-1">
      <input
        ref={inputRef}
        data-testid="activity-filter-input"
        value={value}
        onChange={(e) => handleChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (!suggestions.length) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => (i + 1) % suggestions.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
          } else if (e.key === "Tab" || (e.key === "Enter" && active)) {
            e.preventDefault();
            commitToken(suggestions[index].insert);
          } else if (e.key === "Escape") {
            onChange(value.slice(0, active?.start ?? value.length));
          }
        }}
        placeholder="Filter activity — try from:@pip, in:#general, type:deliverables, or just words"
        className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-[3px] focus:ring-ring/20"
      />
      {suggestions.length > 0 && (
        <div
          data-testid="activity-filter-suggestions"
          className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-md border bg-popover shadow-md"
        >
          {suggestions.map((s, i) => (
            <button
              key={s.insert}
              onMouseDown={(e) => {
                e.preventDefault();
                commitToken(s.insert);
              }}
              className={cn(
                "block w-full truncate px-3 py-1.5 text-left text-sm",
                i === index ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Feed rows ---

function whereLabel(m: ActivityMessage): string {
  const where = m.channel_kind === "dm" ? `@${m.dm_with ?? "dm"}` : `#${m.channel_name}`;
  return m.thread_root_id ? `${where} · in thread` : where;
}

// One message row in the feed. Also used by Home's Catch-up section.
export function MessageRow({
  m,
  personByHandle,
  onJump,
  onOpenProfile,
}: {
  m: ActivityMessage;
  personByHandle: (h?: string | null) => Participant | undefined;
  onJump: () => void;
  onOpenProfile: (id: string) => void;
}) {
  const sender = personByHandle(m.sender_handle);
  return (
    <div
      data-testid="activity-message-row"
      onClick={onJump}
      className="group flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-3 shadow-sm transition-colors hover:border-primary/30"
    >
      <span
        onClick={(e) => {
          e.stopPropagation();
          if (sender) onOpenProfile(sender.id);
        }}
        className="mt-0.5 shrink-0"
      >
        <PersonAvatar name={sender?.display_name ?? m.sender_handle} handle={m.sender_handle} size="sm" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-semibold">{sender?.display_name ?? m.sender_handle}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{fmtRelative(m.created_at)}</span>
          {m.mentions_me && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              <AtSign className="size-2.5" /> Mentioned you
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-sm text-foreground/90">{snippet(m.body) || "(attachment)"}</div>
        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          {m.channel_kind === "dm" ? <AtSign className="size-3" /> : <Hash className="size-3" />}
          <span className="truncate">{whereLabel(m)}</span>
        </div>
      </div>
    </div>
  );
}

// --- The page ---

export function ActivityView({
  channels,
  people,
  personByHandle,
  onOpenProfile,
  onJumpToMessage,
  sidebarOpen,
  onOpenDrawer,
  onExpandSidebar,
  liveTick,
}: {
  channels: Channel[];
  people: Participant[];
  personByHandle: (h?: string | null) => Participant | undefined;
  onOpenProfile: (id: string) => void;
  onJumpToMessage: (channelId: string, messageId: string, threadRootId?: string | null) => void;
  sidebarOpen: boolean;
  onOpenDrawer: () => void;
  onExpandSidebar: () => void;
  // Bumped on every WS message/deliverable — drives the "new activity" pill.
  liveTick: number;
}) {
  const [filters, setFilters] = useState<ActivityFilters>(() => filtersFromLocation().filters);
  const [text, setText] = useState(() => filtersFromLocation().text);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasNew, setHasNew] = useState(false);
  const firstTick = useRef(true);

  // Debounce the free-text remainder so typing doesn't refetch per keystroke.
  const [appliedText, setAppliedText] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setAppliedText(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const fetchFirst = useCallback(
    (f: ActivityFilters, q: string) => {
      setLoading(true);
      setHasNew(false);
      listActivity({ ...f, q: q || undefined }, { limit: PAGE })
        .then((r) => {
          setItems(r.items);
          setHasMore(r.hasMore);
        })
        .catch(() => setItems([]))
        .finally(() => setLoading(false));
    },
    [],
  );

  // Refetch whenever any filter input settles.
  useEffect(() => {
    fetchFirst(filters, appliedText);
    // Filter state is the URL: keep the address bar a shareable deep link.
    history.replaceState({}, "", `/activity${filtersToSearch(filters, appliedText)}`);
  }, [filters, appliedText, fetchFirst]);

  // "New activity" nudge when the WS sees traffic while you're reading the feed.
  useEffect(() => {
    if (firstTick.current) {
      firstTick.current = false;
      return;
    }
    setHasNew(true);
  }, [liveTick]);

  async function loadMore() {
    const last = items[items.length - 1];
    if (!last) return;
    const before = last.type === "message" ? last.message.created_at : last.deliverable.created_at;
    setLoadingMore(true);
    try {
      const r = await listActivity({ ...filters, q: appliedText || undefined }, { before, limit: PAGE });
      setItems((prev) => {
        const seen = new Set(prev.map((x) => (x.type === "message" ? `m:${x.message.message_id}` : `d:${x.deliverable.id}`)));
        return [...prev, ...r.items.filter((x) => !seen.has(x.type === "message" ? `m:${x.message.message_id}` : `d:${x.deliverable.id}`))];
      });
      setHasMore(r.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }

  const mergeToken = useCallback(
    (tok: ActivityFilters) =>
      setFilters((f) => ({
        ...f,
        ...(tok.from ? { from: tok.from } : {}),
        ...(tok.to ? { to: tok.to } : {}),
        ...(tok.inChannel ? { inChannel: tok.inChannel } : {}),
        ...(tok.inDm ? { inDm: tok.inDm } : {}),
        ...(tok.kind ? { kind: tok.kind } : {}),
        ...(tok.direction ? { direction: tok.direction } : {}),
        ...(tok.type && tok.type !== "all" ? { type: tok.type } : {}),
      })),
    [],
  );

  const setType = (type: TypeFilter) =>
    setFilters((f) => ({
      ...f,
      type,
      // Direction is a message-scope concept; it can't constrain deliverables.
      ...(type === "deliverables" ? { direction: undefined } : {}),
    }));
  const setDirection = (direction: Direction | undefined) =>
    setFilters((f) => ({ ...f, direction }));
  const clearField = (key: keyof ActivityFilters) =>
    setFilters((f) => ({ ...f, [key]: undefined }));

  // Removable chips for the person/channel/kind filters (type + direction have pills).
  const chips: { key: keyof ActivityFilters; label: string }[] = [];
  if (filters.from) chips.push({ key: "from", label: chipLabel("from", filters.from) });
  if (filters.to) chips.push({ key: "to", label: chipLabel("to", filters.to) });
  if (filters.person) chips.push({ key: "person", label: chipLabel("person", filters.person) });
  if (filters.inChannel) chips.push({ key: "inChannel", label: chipLabel("inChannel", filters.inChannel) });
  if (filters.inDm) chips.push({ key: "inDm", label: chipLabel("inDm", filters.inDm) });
  if (filters.kind) chips.push({ key: "kind", label: chipLabel("kind", filters.kind) });

  // Group the (already newest-first) feed into day buckets.
  const groups: { label: string; items: ActivityItem[] }[] = [];
  for (const it of items) {
    const ts = it.type === "message" ? it.message.created_at : it.deliverable.created_at;
    const label = dayLabel(ts);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(it);
    else groups.push({ label, items: [it] });
  }

  const typeIsMessages = filters.type !== "deliverables";

  return (
    <ViewShell
      icon={<ActivityIcon className="size-5" />}
      title="Activity"
      sidebarOpen={sidebarOpen}
      onOpenDrawer={onOpenDrawer}
      onExpandSidebar={onExpandSidebar}
      testId="activity-view"
    >
      {/* Sticky filter bar: pills + token input + active chips. */}
      <div className="sticky top-0 z-10 -mx-4 -mt-6 border-b bg-background px-4 pb-3 pt-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill testId="activity-type-all" active={filters.type === "all"} onClick={() => setType("all")}>
            All
          </Pill>
          <Pill
            testId="activity-type-messages"
            active={filters.type === "messages"}
            onClick={() => setType("messages")}
          >
            <MessagesSquare className="mr-1 inline size-3" />
            Messages
          </Pill>
          <Pill
            testId="activity-type-deliverables"
            active={filters.type === "deliverables"}
            onClick={() => setType("deliverables")}
          >
            <Package className="mr-1 inline size-3" />
            Deliverables
          </Pill>
          {typeIsMessages && (
            <>
              <span className="mx-1 h-4 w-px bg-border" />
              {(["sent", "received", "mentions"] as const).map((d) => (
                <Pill
                  key={d}
                  testId={`activity-direction-${d}`}
                  active={filters.direction === d}
                  onClick={() => setDirection(filters.direction === d ? undefined : d)}
                >
                  {d === "mentions" ? "Mentions" : d[0].toUpperCase() + d.slice(1)}
                </Pill>
              ))}
            </>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <TokenInput
            value={text}
            onChange={setText}
            onToken={mergeToken}
            channels={channels}
            people={people}
          />
        </div>
        {chips.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {chips.map((c) => (
              <span
                key={c.key}
                data-testid={`activity-chip-${c.key}`}
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary"
              >
                {c.label}
                <button
                  aria-label={`Remove ${c.label}`}
                  onClick={() => clearField(c.key)}
                  className="rounded-full p-0.5 hover:bg-primary/20"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* "New activity" pill: the WS saw traffic while you were reading. */}
      {hasNew && !loading && (
        <div className="sticky top-24 z-10 flex justify-center">
          <Button
            size="sm"
            data-testid="activity-new-pill"
            onClick={() => fetchFirst(filters, appliedText)}
            className="gap-1.5 rounded-full shadow-md"
          >
            <ArrowUp className="size-3.5" /> New activity
          </Button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed p-10 text-center">
          <ActivityIcon className="mx-auto size-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">Nothing matches</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {chips.length || appliedText || filters.direction
              ? "Try removing a filter or two."
              : "Your messages, mentions, thread replies, and deliverables will land here."}
          </p>
        </div>
      ) : (
        <div className="space-y-6 pt-1">
          {groups.map((g) => (
            <section key={g.label}>
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {g.label}
              </h2>
              <div className="space-y-2">
                {g.items.map((it) =>
                  it.type === "message" ? (
                    <MessageRow
                      key={`m:${it.message.message_id}`}
                      m={it.message}
                      personByHandle={personByHandle}
                      onOpenProfile={onOpenProfile}
                      onJump={() =>
                        onJumpToMessage(it.message.channel_id, it.message.message_id, it.message.thread_root_id)
                      }
                    />
                  ) : (
                    <DeliverableRow
                      key={`d:${it.deliverable.id}`}
                      d={it.deliverable}
                      onJumpToMessage={onJumpToMessage}
                    />
                  ),
                )}
              </div>
            </section>
          ))}
          {hasMore && (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                data-testid="activity-load-more"
                disabled={loadingMore}
                onClick={loadMore}
                className="text-muted-foreground"
              >
                {loadingMore ? "Loading…" : "Load earlier"}
              </Button>
            </div>
          )}
        </div>
      )}
    </ViewShell>
  );
}
