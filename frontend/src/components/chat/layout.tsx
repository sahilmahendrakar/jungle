// Layout/resize primitives + the working indicator, extracted from App.tsx (all module-level,
// closure-free).
import { useState, useEffect } from "react";
import type React from "react";
import { cn } from "@/lib/utils";

// Animated "•••" used in the working indicator.
export function WorkingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-bounce rounded-full bg-primary"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}

// --- Resizable sidebars ------------------------------------------------------
// Both the left nav and the right panel are drag-resizable on desktop (md+). We
// keep pixel widths (not percentages) so the layout is stable as the window
// resizes, and persist them per-side to localStorage.

export const LEFT_WIDTH = { key: "jungle.leftWidth", default: 288, min: 216, max: 480 };
export const RIGHT_WIDTH = { key: "jungle.rightWidth", default: 380, min: 320, max: 620 };

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return matches;
}

export function usePersistedWidth(cfg: { key: string; default: number; min: number; max: number }) {
  const clamp = (n: number) => Math.min(cfg.max, Math.max(cfg.min, n));
  const [width, setWidthRaw] = useState<number>(() => {
    const raw = typeof window !== "undefined" ? localStorage.getItem(cfg.key) : null;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? clamp(n) : cfg.default;
  });
  const setWidth = (n: number) => setWidthRaw(clamp(n));
  useEffect(() => {
    localStorage.setItem(cfg.key, String(width));
  }, [cfg.key, width]);
  return { width, setWidth, reset: () => setWidth(cfg.default) };
}

// A thin, keyboard-accessible drag divider. Rendered in-flow as a flex sibling *between* two
// columns (not inside a panel), so an overflow-hidden panel can't clip its hit area. `edge`
// says which side the resized panel is on: for a panel on the left of the divider ("left"),
// dragging right grows it; for a panel on the right ("right"), dragging right shrinks it.
export function ResizeHandle({
  edge,
  width,
  min,
  max,
  onResize,
  onResizeStart,
  onResizeEnd,
  onReset,
  testId,
  label,
}: {
  edge: "left" | "right";
  width: number;
  min: number;
  max: number;
  onResize: (next: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  onReset?: () => void;
  testId?: string;
  label: string;
}) {
  const delta = (dx: number) => (edge === "left" ? width + dx : width - dx);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    onResizeStart?.();
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      onResize(edge === "left" ? startW + dx : startW - dx);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onResizeEnd?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onResize(delta(-step));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onResize(delta(step));
    }
  };

  return (
    <div
      data-testid={testId}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onReset?.()}
      onKeyDown={onKeyDown}
      className={cn(
        "group relative z-30 hidden w-1.5 shrink-0 cursor-col-resize touch-none select-none md:block",
        "focus-visible:outline-none",
      )}
    >
      {/* Visible hairline centered in the hit strip: subtle by default, brand-colored on
          hover / focus / drag. */}
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary/70" />
    </div>
  );
}
