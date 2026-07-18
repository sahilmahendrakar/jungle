import { useLayoutEffect, useMemo, useRef, type RefObject, type TextareaHTMLAttributes } from "react";
import type { Participant } from "../../api";
import { Textarea } from "@/components/ui/textarea";
import { MentionBadge } from "./MentionBadge";
import { cn } from "@/lib/utils";

// Same charset as Markdown's remarkMentions and the backend's resolveMentions, so the composer
// badges exactly the handles that would render as badges (and notify someone) once sent.
const MENTION_RE = /@([a-zA-Z0-9_-]+)/g;

// The composer textarea with Slack-style mention badges: as you type, any "@handle" that
// resolves to a known participant renders as the same MentionBadge used in chat history —
// hover an agent for its card, click to open the profile.
//
// A textarea can't contain markup, so this uses the mirror-overlay technique: the real textarea
// keeps owning input, caret, selection, and scrolling but paints its text transparent, while an
// overlay with byte-identical typography (same font, padding, and wrap rules — owned here so the
// two can't drift) renders the visible text on top, swapping resolved mentions for badges. The
// overlay is pointer-events-none except on the badges, so every click lands on the textarea as
// usual except a click directly on a badge, which opens the profile.
//
// Badge variant notes (vs. chat history): the badge must occupy EXACTLY the width of the raw
// "@handle" text it replaces or everything after it would drift out of alignment with the real
// (transparent) text underneath — so no horizontal padding overhang (px-0), no font-weight
// change (font-normal), and it labels the raw handle rather than the display name.
export function ComposerInput({
  people,
  onOpenProfile,
  taRef,
  className,
  onScroll,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  people: Participant[];
  onOpenProfile?: (id: string) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const value = String(props.value ?? "");

  // Split the draft into plain-text runs and resolved-mention runs, in order. Unknown handles
  // stay part of the surrounding plain text.
  const segments = useMemo(() => {
    const byHandle = new Map(people.map((p) => [p.handle, p]));
    const segs: { text: string; person?: Participant }[] = [];
    let last = 0;
    MENTION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MENTION_RE.exec(value))) {
      const person = byHandle.get(m[1]);
      if (!person) continue;
      if (m.index > last) segs.push({ text: value.slice(last, m.index) });
      segs.push({ text: m[0], person });
      last = m.index + m[0].length;
    }
    if (last < value.length) segs.push({ text: value.slice(last) });
    return segs;
  }, [value, people]);

  // Keep the overlay scrolled in lockstep with the textarea (content past max-h scrolls).
  const syncScroll = () => {
    const ta = taRef.current;
    const mirror = mirrorRef.current;
    if (ta && mirror) {
      mirror.scrollTop = ta.scrollTop;
      mirror.scrollLeft = ta.scrollLeft;
    }
  };
  useLayoutEffect(syncScroll, [value]);

  return (
    <div className="relative min-w-0 flex-1">
      <Textarea
        ref={taRef}
        className={cn(
          "max-h-40 min-h-9 resize-none overflow-y-auto border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0",
          "text-transparent caret-foreground",
          className,
        )}
        onScroll={(e) => {
          syncScroll();
          onScroll?.(e);
        }}
        {...props}
      />
      {/* Mirror overlay: renders the visible text + badges above the transparent textarea text.
          aria-hidden — the textarea already exposes the real value to AT; badges are tabIndex=-1
          so they're not focusable inside a hidden subtree. */}
      <div
        ref={mirrorRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2 py-1.5 text-sm"
      >
        {segments.map((s, i) =>
          s.person ? (
            <MentionBadge
              key={i}
              person={s.person}
              onOpenProfile={onOpenProfile}
              tabIndex={-1}
              className="pointer-events-auto px-0 py-0 font-normal"
            >
              {s.text}
            </MentionBadge>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
        {/* The textarea paints a phantom empty line when the value ends with "\n"; match it so
            line heights (and the caret's vertical position) stay aligned. */}
        {value.endsWith("\n") ? "​" : null}
      </div>
    </div>
  );
}
