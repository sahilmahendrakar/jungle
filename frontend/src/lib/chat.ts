// Pure helpers, constants, and view types shared across the chat UI (extracted from App.tsx).
import type { AgentStatus, Attachment, Message } from "../api";

// Agent model + permission-mode choices for the create-agent dialog. Model ids must match
// the backend's ALLOWED_MODELS; the first entry is the default.
export const MODEL_OPTIONS = [
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "Most capable" },
  { id: "claude-sonnet-5", label: "Sonnet 5", hint: "Balanced" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "Fastest" },
];
// Agent permission modes (SDK runner). `default` is first (the create-agent default).
export const SDK_MODE_OPTIONS = [
  {
    id: "default",
    label: "Ask on sensitive",
    hint: "Ask before sensitive tools — safe actions run automatically",
  },
  { id: "acceptEdits", label: "Accept edits", hint: "Auto-accept file edits" },
  { id: "plan", label: "Plan only", hint: "Proposes, never changes files" },
  { id: "bypassPermissions", label: "Full autonomy", hint: "Never asks" },
  { id: "dontAsk", label: "Deny unapproved", hint: "Deny anything not pre-approved" },
];
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
  agentName: string;
  agentHandle: string;
  tool: string;
  input: unknown;
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

// Status priority for a channel row with several agent members: the most noteworthy wins.
export const STATUS_RANK: Record<AgentStatus, number> = { working: 0, waking: 1, idle: 2, sleeping: 3 };

// Tailwind classes for an agent's status dot. sleeping is slate (deliberately distinct from
// the muted gray we'd use for a truly-offline participant).
export const STATUS_DOT: Record<AgentStatus, string> = {
  working: "animate-pulse bg-emerald-400",
  idle: "bg-emerald-500/60",
  waking: "animate-pulse bg-amber-400",
  sleeping: "bg-slate-400/70",
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Working",
  idle: "Idle",
  waking: "Waking up",
  sleeping: "Sleeping",
};
