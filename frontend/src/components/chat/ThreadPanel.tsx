import { useEffect, useState } from "react";
import { Check, Hash, MessagesSquare, SendHorizonal, X } from "lucide-react";
import type { Channel, Message, Participant, UnreadThread } from "../../api";
import { fmtTime } from "../../lib/chat";
import { Markdown } from "../../Markdown";
import { AgentBadge, AttachmentList, EmptyState, PersonAvatar } from "./panels";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// Compact message row for the thread panel (root + replies), not sender-grouped.
function ThreadMessageRow({
  m,
  personByHandle,
  onOpenProfile,
}: {
  m: Message;
  personByHandle: (h?: string | null) => Participant | undefined;
  onOpenProfile: (id: string) => void;
}) {
  const sender = personByHandle(m.sender_handle);
  const isAgent = sender?.kind === "agent";
  return (
    <div className="flex gap-2.5">
      <button
        onClick={() => sender && onOpenProfile(sender.id)}
        disabled={!sender}
        className="h-fit shrink-0 rounded-md transition-opacity hover:opacity-80 disabled:cursor-default"
      >
        <PersonAvatar
          name={sender?.display_name ?? m.sender_handle}
          handle={m.sender_handle}
          size="sm"
        />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">
            {sender?.display_name ?? m.sender_handle}
          </span>
          {isAgent && <AgentBadge />}
          <span className="text-xs text-muted-foreground">{fmtTime(m.created_at)}</span>
        </div>
        <div className="break-words text-sm">
          {m.body && (
            <Markdown personByHandle={personByHandle} onOpenProfile={onOpenProfile}>
              {m.body}
            </Markdown>
          )}
          {(m.attachments?.length ?? 0) > 0 && <AttachmentList attachments={m.attachments!} />}
        </div>
      </div>
    </div>
  );
}

// The right panel's Threads view: either the followed-threads-with-unread list, or one open thread
// (root + replies + a reply composer). Owns the reply draft + "also send to channel" toggle, reset
// whenever the open thread changes. `onSendReply` performs the WS post and returns whether it was
// accepted, so the draft clears only on success.
export function ThreadPanel({
  threadRootId,
  threadRoot,
  threadReplies,
  unreadThreads,
  channel,
  personByHandle,
  onOpenProfile,
  onClose,
  onOpenThreadFromList,
  onSendReply,
}: {
  threadRootId: string | null;
  threadRoot: Message | null;
  threadReplies: Message[];
  unreadThreads: UnreadThread[];
  channel: Channel | undefined;
  personByHandle: (h?: string | null) => Participant | undefined;
  onOpenProfile: (id: string) => void;
  onClose: () => void;
  onOpenThreadFromList: (t: UnreadThread) => void;
  onSendReply: (body: string, alsoToChannel: boolean) => boolean;
}) {
  const [threadDraft, setThreadDraft] = useState("");
  const [alsoToChannel, setAlsoToChannel] = useState(false);

  // Reset the composer whenever the open thread changes (or the panel switches to the list).
  useEffect(() => {
    setThreadDraft("");
    setAlsoToChannel(false);
  }, [threadRootId]);

  function send() {
    const body = threadDraft.trim();
    if (!body) return;
    if (!onSendReply(body, alsoToChannel)) return;
    setThreadDraft("");
    setAlsoToChannel(false);
  }

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <MessagesSquare className="size-4 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate font-semibold">
          {threadRootId ? "Thread" : "Threads"}
          {threadRootId && channel && (
            <span className="ml-1.5 font-normal text-muted-foreground">
              {channel.kind === "dm" ? `@${channel.dm_with}` : `#${channel.name}`}
            </span>
          )}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          data-testid="thread-close"
          aria-label="Close thread panel"
          onClick={onClose}
          className="size-8 shrink-0 text-muted-foreground"
        >
          <X className="size-4" />
        </Button>
      </header>

      {/* Threads list mode */}
      {!threadRootId && (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {unreadThreads.length === 0 ? (
            <div className="px-6 pt-16">
              <EmptyState icon={<MessagesSquare className="size-6" />}>
                No unread threads. Replies to threads you follow show up here.
              </EmptyState>
            </div>
          ) : (
            unreadThreads.map((t) => (
              <button
                key={t.root_id}
                data-testid="thread-list-item"
                onClick={() => onOpenThreadFromList(t)}
                className="flex w-full flex-col gap-1 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-accent"
              >
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Hash className="size-3" />
                  <span className="truncate">{t.channel_name}</span>
                  <span className="ml-auto shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                    {t.unread_count} new
                  </span>
                </div>
                <div className="line-clamp-2 text-sm">
                  <span className="font-semibold">@{t.root_sender_handle}</span>{" "}
                  <span className="text-muted-foreground">{t.root_body || "(no text)"}</span>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {t.reply_count} {t.reply_count === 1 ? "reply" : "replies"}
                </div>
              </button>
            ))
          )}
        </div>
      )}

      {/* Open-thread mode */}
      {threadRootId && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {threadRoot ? (
              <div className="flex flex-col gap-4">
                <ThreadMessageRow
                  m={threadRoot}
                  personByHandle={personByHandle}
                  onOpenProfile={onOpenProfile}
                />
                {threadReplies.length > 0 && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />
                    {threadReplies.length}{" "}
                    {threadReplies.length === 1 ? "reply" : "replies"}
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                {threadReplies.map((m) => (
                  <ThreadMessageRow
                    key={m.id}
                    m={m}
                    personByHandle={personByHandle}
                    onOpenProfile={onOpenProfile}
                  />
                ))}
              </div>
            ) : (
              <div className="space-y-4 pt-2">
                <div className="flex gap-2.5">
                  <Skeleton className="size-5 shrink-0 rounded" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-36" />
                    <Skeleton className="h-3.5 w-3/4" />
                  </div>
                </div>
                <div className="flex gap-2.5">
                  <Skeleton className="size-5 shrink-0 rounded" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3.5 w-1/2" />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Thread composer */}
          <div className="shrink-0 px-3 pb-3 pt-1">
            <div className="rounded-xl border bg-card p-2 shadow-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20">
              <div className="flex items-end gap-2">
                <Textarea
                  data-testid="thread-composer-input"
                  value={threadDraft}
                  onChange={(e) => setThreadDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  rows={1}
                  placeholder="Reply in thread…"
                  className="max-h-32 min-h-9 resize-none overflow-y-auto border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
                />
                <Button
                  data-testid="thread-send-button"
                  onClick={send}
                  size="icon"
                  className="shrink-0"
                  aria-label="Send reply"
                >
                  <SendHorizonal className="size-4" />
                </Button>
              </div>
              {/* Also send to channel (Slack) */}
              <label
                data-testid="also-to-channel"
                className="mt-1 flex cursor-pointer select-none items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={alsoToChannel}
                  onClick={() => setAlsoToChannel((v) => !v)}
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                    alsoToChannel
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background",
                  )}
                >
                  {alsoToChannel && <Check className="size-3" />}
                </button>
                Also send to{" "}
                {channel ? (channel.kind === "dm" ? `@${channel.dm_with}` : `#${channel.name}`) : "channel"}
              </label>
            </div>
          </div>
        </>
      )}
    </>
  );
}
