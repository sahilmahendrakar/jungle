import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { FileText, Loader2, X } from "lucide-react";
import { uploadAttachment } from "../../api";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  newId,
  type PendingAttachment,
} from "../../lib/chat";
import { cn } from "@/lib/utils";

// Shared attachment plumbing for the two composers (channel + thread reply): upload-first
// staging, the staged-file chips, and drag-and-drop. Both composers behave identically, so this
// lives here rather than being duplicated — same split as useMentionAutocomplete.

// Stage files and start uploading each immediately (upload-first): the message post only carries
// the ids of uploads that already finished. Pending state is per-composer and deliberately not
// persisted — an in-flight upload can't survive an unmount, unlike the text draft.
export function usePendingAttachments(onNotice: (msg: string) => void) {
  const [pending, setPending] = useState<PendingAttachment[]>([]);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      setPending((ps) => {
        let slots = MAX_ATTACHMENTS_PER_MESSAGE - ps.length;
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
              setPending((cur) =>
                cur.map((p) => (p.key === key ? { ...p, status: "ready" as const, att } : p)),
              ),
            )
            .catch((e) =>
              setPending((cur) =>
                cur.map((p) =>
                  p.key === key
                    ? { ...p, status: "error" as const, error: String((e as Error).message ?? e) }
                    : p,
                ),
              ),
            );
        }
        return chips.length ? [...ps, ...chips] : ps;
      });
    },
    [onNotice],
  );

  const removePending = useCallback((key: string) => {
    setPending((ps) => {
      const gone = ps.find((p) => p.key === key);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return ps.filter((p) => p.key !== key);
    });
  }, []);

  // Called after a successful send: drop the chips and release their object URLs.
  const clearPending = useCallback(() => {
    setPending((ps) => {
      for (const p of ps) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      return [];
    });
  }, []);

  const readyIds = pending.filter((p) => p.status === "ready" && p.att).map((p) => p.att!.id);
  return {
    pending,
    addFiles,
    removePending,
    clearPending,
    readyIds,
    uploading: pending.some((p) => p.status === "uploading"),
  };
}

// The staged-file row shown above a composer's input.
export function PendingAttachmentChips({
  pending,
  onRemove,
}: {
  pending: PendingAttachment[];
  onRemove: (key: string) => void;
}) {
  if (!pending.length) return null;
  return (
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
            onClick={() => onRemove(p.key)}
            aria-label={`Remove ${p.name}`}
            className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

// True when a drag carries actual files (not a text/link drag, and not our own message drags).
function isFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

// Make `ref`'s element a file drop zone; returns whether a file drag is currently over it so the
// caller can render a highlight. dragenter/dragleave fire for every child element crossed, so
// depth is counted rather than toggled — otherwise moving over a child reads as "left the zone".
export function useFileDrop(
  ref: RefObject<HTMLElement | null>,
  onFiles: (files: FileList | File[]) => void,
  enabled = true,
): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); // required, or the browser refuses the drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = e.dataTransfer?.files;
      if (files?.length) onFiles(files);
    };

    el.addEventListener("dragenter", onEnter);
    el.addEventListener("dragover", onOver);
    el.addEventListener("dragleave", onLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragenter", onEnter);
      el.removeEventListener("dragover", onOver);
      el.removeEventListener("dragleave", onLeave);
      el.removeEventListener("drop", onDrop);
      depth.current = 0;
    };
  }, [ref, onFiles, enabled]);

  // A drag that ends outside the zone (dropped elsewhere, or cancelled) never fires our drop
  // handler, so clear the highlight on the window's terminal drag events too.
  useEffect(() => {
    if (!dragging) return;
    const reset = () => {
      depth.current = 0;
      setDragging(false);
    };
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
    };
  }, [dragging]);

  return dragging;
}

// Missing the drop zone shouldn't navigate the tab to the dropped file (the browser default,
// which silently loses whatever you were typing). Mounted once, app-wide.
export function useWindowDropGuard(): void {
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);
}

// The dashed overlay drawn over a composer while a file is dragged over its drop zone.
export function DropOverlay({ label }: { label: string }) {
  return (
    <div
      data-testid="drop-overlay"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-primary"
    >
      {label}
    </div>
  );
}
