// Pure helpers, constants, and view types shared across the chat UI (extracted from App.tsx).
import { MODEL_CATALOG } from "@jungle/shared";
import type { AgentStatus, Attachment, Message } from "../api";

// Agent model choices for the create-agent dialog + settings panel, derived from the shared
// catalog (single source of truth) so the picker never drifts from backend validation. Catalog
// order defines UI order; the first entry is the default for new agents.
export const MODEL_OPTIONS = MODEL_CATALOG.map(({ id, label, hint }) => ({
  id: id as string,
  label,
  hint,
}));
// Label + hint for every backend permission mode (SDK runner). Keyed by mode id so an agent
// already on a mode we no longer surface in the picker still renders correctly in its settings.
export const SDK_MODE_LABELS: Record<string, { label: string; hint: string }> = {
  default: {
    label: "Ask on sensitive",
    hint: "Ask before sensitive tools — safe actions run automatically",
  },
  acceptEdits: { label: "Accept edits", hint: "Auto-accept file edits" },
  plan: { label: "Plan only", hint: "Proposes, never changes files" },
  bypassPermissions: { label: "Full autonomy", hint: "Never asks" },
  dontAsk: { label: "Deny unapproved", hint: "Deny anything not pre-approved" },
};

// The permission modes offered in the picker — a trimmed progressive spectrum (least → most
// autonomy). The backend still accepts the full SDK_MODES set, so agents already on acceptEdits/
// dontAsk keep working; those two are simply no longer offered to new/edited agents here.
export const SDK_MODE_OPTIONS = (["plan", "default", "bypassPermissions"] as const).map((id) => ({
  id: id as string,
  ...SDK_MODE_LABELS[id],
}));

// New agents default to "Ask on sensitive". Decoupled from picker order so it can be reordered.
export const DEFAULT_SDK_MODE = "default";

// Options for editing an EXISTING agent: the trimmed picker plus its current mode if that's no
// longer offered (e.g. a legacy acceptEdits/dontAsk agent) — so we never misrepresent it or
// silently overwrite the setting on save.
export function sdkModeOptionsFor(current: string) {
  if (SDK_MODE_OPTIONS.some((o) => o.id === current)) return SDK_MODE_OPTIONS;
  const extra = SDK_MODE_LABELS[current] ?? { label: current, hint: "" };
  return [...SDK_MODE_OPTIONS, { id: current, ...extra }];
}
// Reasoning effort (SDK `effort`). Ids must match the backend's EFFORT_LEVELS; `medium` is the
// default. Lower = cheaper/faster (fewer thinking tokens + tool-call round-trips); bump repo/
// coding agents up. Haiku ignores effort. Ordered low→high so the default sits mid-list.
export const EFFORT_OPTIONS = [
  { id: "low", label: "Low", hint: "Fastest, cheapest — simple chat/triage" },
  { id: "medium", label: "Medium", hint: "Balanced (default)" },
  { id: "high", label: "High", hint: "Deeper reasoning — harder tasks" },
  { id: "xhigh", label: "Extra high", hint: "Most thorough — heavy coding/agentic work" },
];

// A pending tool-call confirmation surfaced by an always_ask agent.
export interface ToolConfirm {
  confirmId: string;
  channelId: string;
  agentId?: string;
  agentName: string;
  agentHandle: string;
  tool: string;
  input: unknown;
  createdAt?: string;
  status?: "resolved";
  result?: "allow" | "deny";
  by?: string;
}

// A file staged in the composer (upload-first): uploads immediately on add, then its
// Attachment id rides along on the WS post frame when the message is sent.
export interface PendingAttachment {
  key: string; // local chip identity (not the attachment id — that only exists once uploaded)
  name: string;
  size: number;
  mime: string;
  status: "uploading" | "ready" | "error";
  att?: Attachment; // set once the upload succeeds
  error?: string;
  previewUrl?: string; // object URL for image thumbnails; revoked on removal/send
}

// Backend limits (mirrored client-side for immediate feedback).
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Mimes the backend serves inline (rendered as <img>); everything else is a download chip.
export const INLINE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return String(n);
}

export function mergeById(a: Message[], b: Message[]): Message[] {
  const map = new Map<string, Message>();
  for (const m of [...a, ...b]) map.set(m.id, m);
  return [...map.values()].sort((x, y) => Number(x.seq) - Number(y.seq));
}

// If the caret sits inside an "@…" token (an @ at the start or after whitespace, with no
// whitespace up to the caret), return where it starts and the text typed so far. Used to
// drive the @-mention autocomplete. Returns null when there's no active mention token.
export function detectMention(text: string, caret: number): { start: number; query: string } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      const before = i === 0 ? " " : text[i - 1];
      return /\s/.test(before) ? { start: i, query: text.slice(i + 1, caret) } : null;
    }
    if (/\s/.test(ch)) return null; // whitespace before any '@' — not in a mention
  }
  return null;
}

// Works in non-secure contexts (e.g. http://<ip>) where crypto.randomUUID is undefined.
export const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// Coarse relative time for schedule next-/last-run columns: "in 12m", "in 3h", "2d ago".
// Beyond a week it falls back to an absolute date. null/invalid -> "—".
export const fmtRelative = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = t - Date.now();
  const future = diff >= 0;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return "just now";
  let text: string;
  if (mins < 60) text = `${mins}m`;
  else if (mins < 60 * 24) text = `${Math.round(mins / 60)}h`;
  else if (mins < 60 * 24 * 7) text = `${Math.round(mins / (60 * 24))}d`;
  else return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
  return future ? `in ${text}` : `${text} ago`;
};

// Status priority for a channel row with several agent members: the most noteworthy wins.
export const STATUS_RANK: Record<AgentStatus, number> = { working: 0, waking: 1, idle: 2, sleeping: 3, offline: 4 };

// Tailwind classes for an agent's status dot. sleeping is slate (a cloud machine we can wake);
// offline is a dimmer gray ring for a self-hosted agent whose device is disconnected — the backend
// can't wake it, so it reads as truly "not here right now".
export const STATUS_DOT: Record<AgentStatus, string> = {
  working: "animate-pulse bg-emerald-400",
  idle: "bg-emerald-500/60",
  waking: "animate-pulse bg-amber-400",
  sleeping: "bg-slate-400/70",
  offline: "bg-slate-500/40 ring-1 ring-inset ring-slate-500/30",
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Working",
  idle: "Idle",
  waking: "Waking up",
  sleeping: "Sleeping",
  offline: "Offline",
};
