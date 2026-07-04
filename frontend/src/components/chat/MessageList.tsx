import { useEffect, useRef } from "react";
import { MessageSquare, MessagesSquare, Sparkles } from "lucide-react";
import type { Message, Participant } from "../../api";
import { fmtTime } from "../../lib/chat";
import { Markdown } from "../../Markdown";
import { AttachmentList, PersonAvatar } from "./panels";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// The per-message thread affordance: a persistent "N replies" chip on a root that has replies
// (bold + "N new" when I follow it and have unread), a "View thread" link on an also-to-channel
// reply shown in the timeline, or an on-hover "Reply in thread" on everything else.
function ThreadFooter({
  m,
  replyCounts,
  unreadByRoot,
  onOpenThread,
}: {
  m: Message;
  replyCounts: Map<string, number>;
  unreadByRoot: Map<string, number>;
  onOpenThread: (rootId: string) => void;
}) {
  const rootId = m.thread_root_id ?? m.id;
  const isRoot = !m.thread_root_id;
  const count = isRoot ? replyCounts.get(m.id) ?? 0 : 0;
  const unread = unreadByRoot.get(rootId) ?? 0;
  if (isRoot && count > 0) {
    return (
      <button
        data-testid="thread-replies"
        onClick={() => onOpenThread(rootId)}
        className={cn(
          "mt-1 inline-flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-accent",
          unread > 0 && "font-semibold text-primary",
        )}
      >
        <MessageSquare className="size-3.5" />
        {count} {count === 1 ? "reply" : "replies"}
        {unread > 0 && (
          <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
            {unread} new
          </span>
        )}
      </button>
    );
  }
  if (!isRoot) {
    return (
      <button
        data-testid="view-thread"
        onClick={() => onOpenThread(rootId)}
        className="mt-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
      >
        <MessageSquare className="size-3.5" /> In thread
      </button>
    );
  }
  // Corner popover (Slack-style): absolutely positioned so it never reserves layout space, and
  // anchored to this message's own line (not the sender header) so it works the same on every
  // line of a consecutive/grouped run from one sender.
  return (
    <div className="pointer-events-none absolute -top-3.5 right-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-testid="reply-in-thread"
            onClick={() => onOpenThread(rootId)}
            className="pointer-events-auto flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-sm hover:bg-accent hover:text-accent-foreground"
          >
            <MessageSquare className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">Reply in thread</TooltipContent>
      </Tooltip>
    </div>
  );
}

// The main channel timeline: sender-grouped message rows with per-message thread footers, plus the
// empty-channel hint. Owns its own scroll viewport, kept pinned to the newest message whenever the
// grouped content or the open channel changes.
export function MessageList({
  grouped,
  hasChannel,
  channelId,
  headerTitle,
  personByHandle,
  onOpenProfile,
  replyCounts,
  unreadByRoot,
  onOpenThread,
}: {
  grouped: { lead: Message; rest: Message[] }[];
  hasChannel: boolean;
  channelId: string | null;
  headerTitle: string | null;
  personByHandle: (h?: string | null) => Participant | undefined;
  onOpenProfile: (id: string) => void;
  replyCounts: Map<string, number>;
  unreadByRoot: Map<string, number>;
  onOpenThread: (rootId: string) => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Keep the message list pinned to the newest message.
  useEffect(() => {
    const vp = viewportRef.current;
    if (vp) vp.scrollTop = vp.scrollHeight;
  }, [grouped, channelId]);

  return (
    <div ref={viewportRef} className="min-h-0 flex-1 overflow-y-auto">
      <div data-testid="message-list" className="flex flex-col gap-5 px-3 py-6 md:px-5">
        {hasChannel && grouped.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 pt-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
              <MessagesSquare className="size-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">
              This is the start of {headerTitle}. Say something — or{" "}
              <span className="font-medium text-foreground">@mention</span>{" "}
              an agent to put it to work.
            </p>
          </div>
        )}

        {grouped.map(({ lead, rest }) => {
          const sender = personByHandle(lead.sender_handle);
          const isAgent = sender?.kind === "agent";
          return (
            <div key={lead.id} className="flex gap-3">
              <button
                onClick={() => sender && onOpenProfile(sender.id)}
                disabled={!sender}
                className="h-fit shrink-0 rounded-md transition-opacity hover:opacity-80 disabled:cursor-default"
                title={sender ? `View @${sender.handle}` : undefined}
              >
                <PersonAvatar
                  name={sender?.display_name ?? lead.sender_handle}
                  handle={lead.sender_handle}
                />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <button
                    data-testid="message-sender"
                    onClick={() => sender && onOpenProfile(sender.id)}
                    disabled={!sender}
                    className="font-semibold hover:underline disabled:no-underline"
                  >
                    {sender?.display_name ?? lead.sender_handle}
                  </button>
                  {isAgent && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      <Sparkles className="size-2.5" /> agent
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {fmtTime(lead.created_at)}
                  </span>
                </div>
                <div data-testid="message" className="group/msg relative break-words">
                  {lead.body && (
                    <Markdown personByHandle={personByHandle} onOpenProfile={onOpenProfile}>
                      {lead.body}
                    </Markdown>
                  )}
                  {(lead.attachments?.length ?? 0) > 0 && (
                    <AttachmentList attachments={lead.attachments!} />
                  )}
                  <ThreadFooter
                    m={lead}
                    replyCounts={replyCounts}
                    unreadByRoot={unreadByRoot}
                    onOpenThread={onOpenThread}
                  />
                </div>
                {rest.map((m) => (
                  <div key={m.id} data-testid="message" className="group/msg relative mt-1 break-words">
                    {m.body && (
                      <Markdown personByHandle={personByHandle} onOpenProfile={onOpenProfile}>
                        {m.body}
                      </Markdown>
                    )}
                    {(m.attachments?.length ?? 0) > 0 && (
                      <AttachmentList attachments={m.attachments!} />
                    )}
                    <ThreadFooter
                      m={m}
                      replyCounts={replyCounts}
                      unreadByRoot={unreadByRoot}
                      onOpenThread={onOpenThread}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
