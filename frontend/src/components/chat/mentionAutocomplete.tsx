import { useCallback, useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import { Bot } from "lucide-react";
import { type Participant } from "../../api";
import { detectMention } from "../../lib/chat";
import { PersonAvatar } from "./panels";
import { cn } from "@/lib/utils";

// Shared @-mention autocomplete for the channel + thread composers. Extracted from Composer.tsx
// so the thread composer gets the same behavior (popup, keyboard nav, accept-and-restore-caret)
// without duplicating the logic. The hook owns the mention token + active index + candidate list;
// the parent wires its textarea's onChange/onSelect/onKeyDown to `syncMention` / `handleKey` and
// renders <MentionPopup> when candidates exist.

export interface MentionToken {
  start: number;
  query: string;
}

export function useMentionAutocomplete({
  people,
  members,
  participantId,
  draft,
  setDraft,
  taRef,
}: {
  people: Participant[];
  members: Participant[];
  participantId: string | null;
  draft: string;
  setDraft: (v: string) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [mention, setMention] = useState<MentionToken | null>(null);
  const [index, setIndex] = useState(0);

  // Candidates: everyone but me, matching the typed query, with current channel members surfaced
  // first, then handle-prefix matches.
  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const memberIds = new Set(members.map((m) => m.id));
    return people
      .filter((p) => p.id !== participantId)
      .filter(
        (p) => !q || p.handle.toLowerCase().includes(q) || p.display_name.toLowerCase().includes(q),
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
  const syncMention = useCallback((value: string, caret: number) => {
    setMention(detectMention(value, caret));
    setIndex(0);
  }, []);

  // Replace the in-progress "@query" token with "@handle " and drop the popup.
  const acceptMention = useCallback(
    (p: Participant) => {
      setMention((m) => {
        const ta = taRef.current;
        if (!m) return m;
        const caret = ta?.selectionStart ?? m.start + 1 + m.query.length;
        const before = draft.slice(0, m.start);
        const after = draft.slice(caret);
        const insert = `@${p.handle} `;
        const next = before + insert + after;
        setDraft(next);
        const pos = (before + insert).length;
        requestAnimationFrame(() => {
          if (ta) {
            ta.focus();
            ta.setSelectionRange(pos, pos);
          }
        });
        return null;
      });
    },
    [draft, setDraft, taRef],
  );

  const clearMention = useCallback(() => {
    setMention(null);
    setIndex(0);
  }, []);

  // Keyboard nav for the popup. Returns true if it handled the key (caller skips its own handling).
  const handleKey = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!mention || candidates.length === 0) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => (i + 1) % candidates.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => (i - 1 + candidates.length) % candidates.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptMention(candidates[index]);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return true;
      }
      return false;
    },
    [mention, candidates, index, acceptMention],
  );

  return { mention, candidates, index, setIndex, syncMention, acceptMention, clearMention, handleKey };
}

// The autocomplete dropdown. Position it inside a `relative` container; it floats above the
// textarea (bottom-full). Pure presentational — driven by candidates + active index.
export function MentionPopup({
  candidates,
  index,
  onSelect,
  onHover,
}: {
  candidates: Participant[];
  index: number;
  onSelect: (p: Participant) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div
      data-testid="mention-popup"
      className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
    >
      <div className="max-h-64 overflow-y-auto p-1">
        {candidates.map((p, i) => (
          <button
            key={p.id}
            data-testid="mention-option"
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(p);
            }}
            onMouseEnter={() => onHover(i)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm",
              i === index ? "bg-accent" : "hover:bg-accent/60",
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
  );
}
