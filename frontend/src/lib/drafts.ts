import { useState } from "react";

// Composer draft persistence (Slack-style). Drafts are keyed by target — the channel id for the
// main composer, `thread:<rootId>` for thread replies — and mirrored to localStorage, so they
// survive navigation to overlay screens (which unmount the chat column), channel/thread switches,
// and full page reloads. An in-memory map fronts localStorage for synchronous reads on remount
// and as the fallback when storage is unavailable (e.g. private mode).

const PREFIX = "jungle.draft:";
const cache = new Map<string, string>();

function read(key: string): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(PREFIX + key);
  } catch {
    // Storage unavailable — in-memory only for this session.
  }
  const value = stored ?? "";
  cache.set(key, value);
  return value;
}

function write(key: string, value: string) {
  if (value) cache.set(key, value);
  else cache.delete(key);
  try {
    if (value) localStorage.setItem(PREFIX + key, value);
    else localStorage.removeItem(PREFIX + key); // sent/cleared drafts leave nothing behind
  } catch {
    // Storage unavailable — the in-memory copy above still covers this session.
  }
}

// useState-compatible string state bound to a draft key. Every change writes through to the
// store, so unmounting never loses text; changing the key loads that key's saved draft; setting
// "" removes the entry. A null key (no target selected) degrades to plain ephemeral state.
export function usePersistentDraft(key: string | null): [string, (v: string) => void] {
  const [cur, setCur] = useState(() => ({ key, value: key ? read(key) : "" }));
  // The value this render should show: state normally, but on a key change read the new key's
  // draft directly so the previous target's text never flashes for a frame…
  const effective = cur.key === key ? cur.value : key ? read(key) : "";
  // …then sync state to the new key during render (React's adjust-state-on-prop-change pattern;
  // re-renders before commit, no effect needed).
  if (cur.key !== key) setCur({ key, value: effective });
  const set = (v: string) => {
    setCur({ key, value: v });
    if (key) write(key, v);
  };
  return [effective, set];
}
