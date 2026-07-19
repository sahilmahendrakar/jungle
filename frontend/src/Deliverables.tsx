import { ExternalLink, MessageSquare } from "lucide-react";
import type { Deliverable } from "./api";
import { fmtRelative } from "./lib/chat";
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

// A deliverable row — one durable work artifact (PR, doc, issue, …) an agent produced. Shared
// by Home's "while you were away" section and the Activity page's deliverables feed (the
// standalone Deliverables page was absorbed into /activity?type=deliverables).
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
