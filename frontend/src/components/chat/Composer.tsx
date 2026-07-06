import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bot, FileText, Loader2, Paperclip, SendHorizonal, X } from "lucide-react";
import { uploadAttachment, type Participant } from "../../api";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  detectMention,
  newId,
  type PendingAttachment,
} from "../../lib/chat";
import { PersonAvatar } from "./panels";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// The main channel composer: @-mention autocomplete, upload-first attachments, and an auto-growing
// textarea. Owns its own draft / pending-attachments / mention state; the parent only supplies the
// data needed for mention candidates and an `onSend(body, attachmentIds)` that performs the actual
// WS post and returns whether it was accepted (so the composer clears only on success).
export function Composer({
  headerTitle,
  isDm,
  people,
  members,
  participantId,
  onSend,
  onNotice,
}: {
  headerTitle: string | null;
  isDm: boolean;
  people: Participant[];
  members: Participant[];
  participantId: string | null;
  onSend: (body: string, attachmentIds: string[]) => boolean;
  onNotice: (msg: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Auto-grow: match the textarea height to its content up to the CSS max (max-h-40), keyed on
  // draft so it also shrinks back after sending or accepting a mention.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [draft]);

  // Candidates for the @-mention popup: everyone but me, matching the typed query, with current
  // channel members surfaced first, then handle-prefix matches.
  const mentionCandidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const memberIds = new Set(members.map((m) => m.id));
    return people
      .filter((p) => p.id !== participantId)
      .filter(
        (p) =>
          !q ||
          p.handle.toLowerCase().includes(q) ||
          p.display_name.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const am = memberIds.has(a.id) ? 0 : 1;
        const bm = memberIds.has(b.id) ? 0 : 1;
        if (am !== bm) return am - bm;
        const asw = a.handle.toLowerCase().startsWith(q) ? 0 : 1;
        const bsw = b.handle.toLowerCase().startsWith(q) ? 0 : 1;
        if (asw !== bsw) return asw - bsw;
        return a.display_name.localeCompare(b.display_name);
      })
      .slice(0, 8);
  }, [mention, people, members, participantId]);

  // Recompute the active mention token from the textarea's current value + caret.
  function syncMention(value: string, caret: number) {
    setMention(detectMention(value, caret));
    setMentionIndex(0);
  }

  // Replace the in-progress "@query" token with "@handle " and drop the popup.
  function acceptMention(p: Participant) {
    const m = mention;
    const ta = taRef.current;
    if (!m) return;
    const caret = ta?.selectionStart ?? m.start + 1 + m.query.length;
    const before = draft.slice(0, m.start);
    const after = draft.slice(caret);
    const insert = `@${p.handle} `;
    const next = before + insert + after;
    setDraft(next);
    setMention(null);
    const pos = (before + insert).length;
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  }

  // Stage files in the composer and start uploading each immediately (upload-first). Shared by the
  // paperclip picker and paste-into-textarea.
  function addFiles(files: FileList | File[]) {
    let slots = MAX_ATTACHMENTS_PER_MESSAGE - pending.length;
    const chips: PendingAttachment[] = [];
    for (const file of Array.from(files)) {
      if (slots <= 0) {
        onNotice(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`);
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        onNotice(`"${file.name}" is too large (max 25MB per file).`);
        continue;
      }
      slots--;
      const key = newId();
      chips.push({
        key,
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        status: "uploading",
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      });
      uploadAttachment(file)
        .then((att) =>
          setPending((ps) =>
            ps.map((p) => (p.key === key ? { ...p, status: "ready" as const, att } : p)),
          ),
        )
        .catch((e) =>
          setPending((ps) =>
            ps.map((p) =>
              p.key === key
                ? { ...p, status: "error" as const, error: String((e as Error).message ?? e) }
                : p,
            ),
          ),
        );
    }
    if (chips.length) setPending((ps) => [...ps, ...chips]);
  }

  function removePending(key: string) {
    const gone = pending.find((p) => p.key === key);
    if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
    setPending((ps) => ps.filter((p) => p.key !== key));
  }

  function send() {
    const body = draft.trim();
    const readyIds = pending
      .filter((p) => p.status === "ready" && p.att)
      .map((p) => p.att!.id);
    if (!body && readyIds.length === 0) return;
    if (pending.some((p) => p.status === "uploading")) {
      onNotice("Wait for uploads to finish.");
      return;
    }
    // No optimistic echo — the parent posts over WS and the message appears when it round-trips
    // back. onSend returns false (and surfaces its own notice) if it couldn't send.
    if (!onSend(body, readyIds)) return;
    setDraft("");
    for (const p of pending) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    setPending([]);
    setMention(null);
  }

  // Anything ready to send? Drives the send button's enabled/dimmed affordance.
  const canSend =
    draft.trim().length > 0 || pending.some((p) => p.status === "ready" && p.att);

  return (
    <div className="px-3 pb-3 pt-1 md:px-5 md:pb-5">
      <div className="relative rounded-2xl border bg-card p-2 shadow-sm transition-shadow focus-within:border-ring focus-within:shadow-md focus-within:ring-[3px] focus-within:ring-ring/20">
        {/* @-mention autocomplete */}
        {mention && mentionCandidates.length > 0 && (
          <div
            data-testid="mention-popup"
            className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
          >
            <div className="max-h-64 overflow-y-auto p-1">
              {mentionCandidates.map((p, i) => (
                <button
                  key={p.id}
                  data-testid="mention-option"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    acceptMention(p);
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm",
                    i === mentionIndex ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <PersonAvatar name={p.display_name} handle={p.handle} size="sm" />
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate font-medium">{p.display_name}</span>
                    <span className="truncate text-muted-foreground">@{p.handle}</span>
                    {p.kind === "agent" && <Bot className="size-3.5 shrink-0 text-primary" />}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {/* Staged attachments (upload-first): thumbnails for images, a file icon otherwise. */}
        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 px-1">
            {pending.map((p) => (
              <div
                key={p.key}
                data-testid="pending-attachment"
                data-status={p.status}
                className={cn(
                  "flex items-center gap-2 rounded-lg border bg-muted/40 py-1 pl-1.5 pr-1.5 text-sm",
                  p.status === "error" && "border-destructive/40 bg-destructive/5",
                )}
              >
                {p.previewUrl ? (
                  <img
                    src={p.previewUrl}
                    alt={p.name}
                    className="size-9 shrink-0 rounded-md border object-cover"
                  />
                ) : (
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background">
                    <FileText className="size-4 text-muted-foreground" />
                  </span>
                )}
                <span className="max-w-40 truncate">{p.name}</span>
                {p.status === "uploading" && (
                  <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                )}
                {p.status === "error" && (
                  <span className="shrink-0 text-xs text-destructive" title={p.error}>
                    failed
                  </span>
                )}
                <button
                  data-testid="pending-attachment-remove"
                  onClick={() => removePending(p.key)}
                  aria-label={`Remove ${p.name}`}
                  className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileRef}
            data-testid="attach-input"
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = ""; // allow re-picking the same file
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            data-testid="attach-button"
            aria-label="Attach files"
            title="Attach files"
            onClick={() => fileRef.current?.click()}
            className="shrink-0 text-muted-foreground"
          >
            <Paperclip className="size-4" />
          </Button>
          <Textarea
            ref={taRef}
            data-testid="composer-input"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
              }
            }}
            onSelect={(e) => {
              const t = e.target as HTMLTextAreaElement;
              syncMention(t.value, t.selectionStart ?? 0);
            }}
            onKeyDown={(e) => {
              if (mention && mentionCandidates.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % mentionCandidates.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIndex(
                    (i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length,
                  );
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  acceptMention(mentionCandidates[mentionIndex]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMention(null);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={
              headerTitle
                ? `Message ${isDm ? headerTitle : "#" + headerTitle}`
                : "Select or create a channel"
            }
            className="max-h-40 min-h-9 resize-none overflow-y-auto border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
          />
          <Button
            data-testid="send-button"
            onClick={send}
            size="icon"
            aria-label="Send"
            className={cn(
              "shrink-0 transition-all",
              !canSend && "pointer-events-none bg-muted text-muted-foreground shadow-none",
            )}
          >
            <SendHorizonal className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
