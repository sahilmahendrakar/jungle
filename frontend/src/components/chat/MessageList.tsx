import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, MessageSquare, MessagesSquare } from "lucide-react";
import type { Message, Participant } from "../../api";
import { fmtTime } from "../../lib/chat";
import { Markdown } from "../../Markdown";
import { AgentBadge, AttachmentList, EmptyState, PersonAvatar } from "./panels";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// The per-message thread affordance that RESERVES layout space: a persistent "N replies" chip on
// a root that has replies (bold + "N new" when I follow it and have unread), or a "View thread"
// link on an also-to-channel reply shown in the timeline. The on-hover "reply in thread" action
// lives in the HoverActions bar instead.
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
  return null;
}

// Slack-style hover action bar, absolutely positioned at the message row's top-right corner so
// it never reserves layout space. Carries the message's timestamp (grouped follow-up rows have
// no visible time otherwise), copy-text, and reply-in-thread (roots without replies only — once
// a thread exists the persistent chip below the message is the affordance).
function HoverActions({
  m,
  showReply,
  onOpenThread,
}: {
  m: Message;
  showReply: boolean;
  onOpenThread: (rootId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard?.writeText(m.body ?? "").then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  }, [m.body]);
  return (
    <div className="pointer-events-none absolute -top-4 right-1.5 z-10 opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border bg-card p-0.5 shadow-md">
        <span className="px-1.5 text-[11px] tabular-nums text-muted-foreground">
          {fmtTime(m.created_at)}
        </span>
        {m.body && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-testid="message-copy"
                onClick={copy}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{copied ? "Copied" : "Copy text"}</TooltipContent>
          </Tooltip>
        )}
        {showReply && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-testid="reply-in-thread"
                onClick={() => onOpenThread(m.thread_root_id ?? m.id)}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <MessageSquare className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Reply in thread</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

// One message row body: markdown + attachments + hover actions + thread footer.
function MessageBody({
  m,
  className,
  animate,
  personByHandle,
  onOpenProfile,
  replyCounts,
  unreadByRoot,
  onOpenThread,
}: {
  m: Message;
  className?: string;
  animate: boolean;
  personByHandle: (h?: string | null) => Participant | undefined;
  onOpenProfile: (id: string) => void;
  replyCounts: Map<string, number>;
  unreadByRoot: Map<string, number>;
  onOpenThread: (rootId: string) => void;
}) {
  const isRoot = !m.thread_root_id;
  const hasReplies = isRoot && (replyCounts.get(m.id) ?? 0) > 0;
  return (
    <div
      data-testid="message"
      className={cn("group/msg relative break-words", animate && "animate-msg-in", className)}
    >
      {m.body && (
        <Markdown personByHandle={personByHandle} onOpenProfile={onOpenProfile}>
          {m.body}
        </Markdown>
      )}
      {(m.attachments?.length ?? 0) > 0 && <AttachmentList attachments={m.attachments!} />}
      <ThreadFooter
        m={m}
        replyCounts={replyCounts}
        unreadByRoot={unreadByRoot}
        onOpenThread={onOpenThread}
      />
      <HoverActions m={m} showReply={isRoot && !hasReplies} onOpenThread={onOpenThread} />
    </div>
  );
}

// The main channel timeline: sender-grouped message rows with hover actions and per-message
// thread footers, plus the empty-channel hint. Owns its own scroll viewport: pinned to the
// newest message while the user is at the bottom, but never yanks them down while they're
// scrolled up reading history (jump-to-bottom only on channel switch).
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
  const pinnedRef = useRef(true);

  // Track whether the user is at (near) the bottom, so new content only auto-scrolls when
  // they were already reading the newest messages.
  const onScroll = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    pinnedRef.current = vp.scrollHeight - vp.scrollTop - vp.clientHeight < 60;
  }, []);

  // Channel switch: always jump to the newest message and reset the pin.
  useEffect(() => {
    pinnedRef.current = true;
    const vp = viewportRef.current;
    if (vp) vp.scrollTop = vp.scrollHeight;
  }, [channelId]);

  // New content: keep pinned to the bottom only while the user is there.
  useEffect(() => {
    const vp = viewportRef.current;
    if (vp && pinnedRef.current) vp.scrollTop = vp.scrollHeight;
  }, [grouped]);

  // Only animate messages that arrive AFTER the initial render of a channel — a full history
  // load shouldn't play 200 entrance animations. Seen-set is rebuilt on channel switch.
  const seenRef = useRef<{ channel: string | null; ids: Set<string> }>({
    channel: null,
    ids: new Set(),
  });
  if (seenRef.current.channel !== channelId) {
    seenRef.current = { channel: channelId, ids: new Set() };
  }
  const firstRender = seenRef.current.ids.size === 0;
  const isNew = (id: string) => !firstRender && !seenRef.current.ids.has(id);
  useEffect(() => {
    for (const { lead, rest } of grouped) {
      seenRef.current.ids.add(lead.id);
      for (const m of rest) seenRef.current.ids.add(m.id);
    }
  }, [grouped]);

  return (
    <div ref={viewportRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div data-testid="message-list" className="flex flex-col gap-5 px-3 py-6 md:px-5">
        {hasChannel && grouped.length === 0 && (
          <div className="pt-16">
            <EmptyState icon={<MessagesSquare className="size-6" />}>
              This is the start of {headerTitle}. Say something — or{" "}
              <span className="font-medium text-foreground">@mention</span> an agent to put it to
              work.
            </EmptyState>
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
                  {isAgent && <AgentBadge />}
                  <span className="text-xs text-muted-foreground">
                    {fmtTime(lead.created_at)}
                  </span>
                </div>
                <MessageBody
                  m={lead}
                  animate={isNew(lead.id)}
                  personByHandle={personByHandle}
                  onOpenProfile={onOpenProfile}
                  replyCounts={replyCounts}
                  unreadByRoot={unreadByRoot}
                  onOpenThread={onOpenThread}
                />
                {rest.map((m) => (
                  <MessageBody
                    key={m.id}
                    m={m}
                    className="mt-1"
                    animate={isNew(m.id)}
                    personByHandle={personByHandle}
                    onOpenProfile={onOpenProfile}
                    replyCounts={replyCounts}
                    unreadByRoot={unreadByRoot}
                    onOpenThread={onOpenThread}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
