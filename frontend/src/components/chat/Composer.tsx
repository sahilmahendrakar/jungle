import { useLayoutEffect, useRef, type RefObject } from "react";
import { Paperclip, SendHorizonal } from "lucide-react";
import { type Participant } from "../../api";
import { usePersistentDraft } from "../../lib/drafts";
import { useMentionAutocomplete, MentionPopup } from "./mentionAutocomplete";
import { ComposerInput } from "./ComposerInput";
import {
  DropOverlay,
  PendingAttachmentChips,
  useFileDrop,
  usePendingAttachments,
} from "./attachments";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The main channel composer: @-mention autocomplete, mention badges in the input (same component
// as chat history via ComposerInput), upload-first attachments, and an auto-growing textarea.
// The draft is persisted per channel (see lib/drafts.ts) — navigating to another screen,
// switching channels, or reloading the page restores it, and it clears on send. Pending
// attachments stay component-local (in-flight uploads can't survive an unmount). Mention
// autocomplete lives in the shared useMentionAutocomplete hook (shared with the thread composer),
// and attachment staging/drop in ./attachments. The parent only supplies the data needed for
// mention candidates and an `onSend(body, attachmentIds)` that performs the actual WS post and
// returns whether it was accepted (so the composer clears only on success).
export function Composer({
  draftKey,
  headerTitle,
  isDm,
  people,
  members,
  participantId,
  onSend,
  onNotice,
  onOpenProfile,
  dropTargetRef,
}: {
  // Persistence key for the draft — the selected channel id (see lib/drafts.ts).
  draftKey: string | null;
  headerTitle: string | null;
  isDm: boolean;
  people: Participant[];
  members: Participant[];
  participantId: string | null;
  onSend: (body: string, attachmentIds: string[]) => boolean;
  onNotice: (msg: string) => void;
  onOpenProfile?: (id: string) => void;
  // Element that accepts dropped files. Defaults to the composer itself, but the parent passes
  // the whole message pane so a screenshot can be dropped anywhere in the conversation.
  dropTargetRef?: RefObject<HTMLElement | null>;
}) {
  const [draft, setDraft] = usePersistentDraft(draftKey);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const { pending, addFiles, removePending, clearPending, readyIds, uploading } =
    usePendingAttachments(onNotice);
  const dragging = useFileDrop(dropTargetRef ?? rootRef, addFiles, !!draftKey);

  const { mention, candidates, index, setIndex, syncMention, acceptMention, clearMention, handleKey } =
    useMentionAutocomplete({ people, members, participantId, draft, setDraft, taRef });

  // Auto-grow: match the textarea height to its content up to the CSS max (max-h-40), keyed on
  // draft so it also shrinks back after sending or accepting a mention.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [draft]);

  function send() {
    const body = draft.trim();
    if (!body && readyIds.length === 0) return;
    if (uploading) {
      onNotice("Wait for uploads to finish.");
      return;
    }
    // No optimistic echo — the parent posts over WS and the message appears when it round-trips
    // back. onSend returns false (and surfaces its own notice) if it couldn't send.
    if (!onSend(body, readyIds)) return;
    setDraft("");
    clearPending();
    clearMention();
  }

  // Anything ready to send? Drives the send button's enabled/dimmed affordance.
  const canSend = draft.trim().length > 0 || readyIds.length > 0;

  return (
    <div ref={rootRef} className="px-3 pb-3 pt-1 md:px-5 md:pb-5">
      <div className="relative rounded-2xl border bg-card p-2 shadow-sm transition-shadow focus-within:border-ring focus-within:shadow-md focus-within:ring-[3px] focus-within:ring-ring/20">
        {dragging && <DropOverlay label="Drop files to attach" />}
        {/* @-mention autocomplete */}
        {mention && candidates.length > 0 && (
          <MentionPopup
            candidates={candidates}
            index={index}
            onSelect={acceptMention}
            onHover={setIndex}
          />
        )}
        {/* Staged attachments (upload-first): thumbnails for images, a file icon otherwise. */}
        <PendingAttachmentChips pending={pending} onRemove={removePending} />
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
          <ComposerInput
            taRef={taRef}
            people={people}
            onOpenProfile={onOpenProfile}
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
              if (handleKey(e)) return;
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
