import { useState } from "react";
import { ExternalLink, Loader2, MessageSquare, Package } from "lucide-react";
import type { Deliverable } from "./api";
import { fmtRelative } from "./lib/chat";
import { ViewShell } from "./components/chat/ViewShell";
import {
  DELIVERABLE_KIND_META,
  shortDeliverableUrl,
} from "./components/chat/deliverableCards";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// The Deliverables feed: the workspace's durable "what got shipped" record — every PR, doc,
// issue, … agents produced, extracted from their messages. Chat scrolls away; this doesn't.

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

export function DeliverableRow({
  d,
  onJumpToMessage,
}: {
  d: Deliverable;
  onJumpToMessage: (channelId: string, messageId: string) => void;
}) {
  const meta = DELIVERABLE_KIND_META[d.kind];
  const Icon = meta.icon;
  const where = d.channel_kind === "dm" ? "a DM" : `#${d.channel_name}`;
  return (
    <div
      data-testid="deliverable-row"
      className="group flex items-center gap-3 rounded-xl border bg-card p-3 shadow-sm transition-colors hover:border-primary/30"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
        <Icon className="size-4 text-primary" />
      </span>
      <div className="min-w-0 flex-1">
        <a
          href={d.url}
          target="_blank"
          rel="noreferrer"
          className="block truncate text-sm font-medium hover:underline"
        >
          {d.title ?? shortDeliverableUrl(d.url)}
        </a>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {meta.label} · @{d.agent_handle} in {where} · {fmtRelative(d.created_at)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              data-testid="deliverable-jump"
              onClick={() => onJumpToMessage(d.channel_id, d.message_id)}
              className="size-8 text-muted-foreground"
            >
              <MessageSquare className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Go to the conversation</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" asChild className="size-8 text-muted-foreground">
              <a href={d.url} target="_blank" rel="noreferrer" aria-label="Open link">
                <ExternalLink className="size-4" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

export function DeliverablesView({
  deliverables,
  loading,
  hasMore,
  onLoadMore,
  sidebarOpen,
  onOpenDrawer,
  onExpandSidebar,
  onJumpToMessage,
}: {
  deliverables: Deliverable[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
  sidebarOpen: boolean;
  onOpenDrawer: () => void;
  onExpandSidebar: () => void;
  onJumpToMessage: (channelId: string, messageId: string) => void;
}) {
  const [loadingMore, setLoadingMore] = useState(false);

  // Group by calendar day, newest first (the list arrives newest-first already).
  const groups: { label: string; items: Deliverable[] }[] = [];
  for (const d of deliverables) {
    const label = dayLabel(d.created_at);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(d);
    else groups.push({ label, items: [d] });
  }

  return (
    <ViewShell
      icon={<Package className="size-5" />}
      title="Deliverables"
      sidebarOpen={sidebarOpen}
      onOpenDrawer={onOpenDrawer}
      onExpandSidebar={onExpandSidebar}
      testId="deliverables-view"
    >
      {loading ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : deliverables.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <Package className="mx-auto size-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">Nothing shipped yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            When agents open PRs, write docs, or file issues, the links land here — a durable
            record of the work, even after chat scrolls away.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.label}>
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {g.label}
              </h2>
              <div className="space-y-2">
                {g.items.map((d) => (
                  <DeliverableRow key={d.id} d={d} onJumpToMessage={onJumpToMessage} />
                ))}
              </div>
            </section>
          ))}
          {hasMore && (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                disabled={loadingMore}
                onClick={async () => {
                  setLoadingMore(true);
                  try {
                    await onLoadMore();
                  } finally {
                    setLoadingMore(false);
                  }
                }}
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
