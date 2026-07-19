// Pure helpers + constants ported from frontend/src/lib/chat.ts. Framework-agnostic (no React),
// so this is a near-verbatim copy shared by the message list, composer, chips, and settings.
import { MODEL_CATALOG } from "@jungle/shared";
import type { AgentStatus } from "@jungle/shared";
import type { Attachment, Message } from "./api";

// Agent model choices (create/settings), derived from the shared catalog so the picker never
// drifts from backend validation. First entry is the default for new agents.
export const MODEL_OPTIONS = MODEL_CATALOG.map(({ id, label, hint }) => ({
  id: id as string,
  label,
  hint,
}));

// Agent permission modes (SDK runner). `default` first (create-agent default).
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

// Reasoning effort (SDK `effort`); `medium` is the default. Low→high so default sits mid-list.
export const EFFORT_OPTIONS = [
  { id: "low", label: "Low", hint: "Fastest, cheapest — simple chat/triage" },
  { id: "medium", label: "Medium", hint: "Balanced (default)" },
  { id: "high", label: "High", hint: "Deeper reasoning — harder tasks" },
  { id: "xhigh", label: "Extra high", hint: "Most thorough — heavy coding/agentic work" },
];

// A file staged in the composer (upload-first): uploads immediately on add, then its Attachment
// id rides along on the WS post frame when the message is sent.
export interface PendingAttachment {
  key: string;
  name: string;
  size: number;
  mime: string;
  status: "uploading" | "ready" | "error";
  att?: Attachment;
  error?: string;
  localUri?: string; // device uri for an image thumbnail while/after uploading
}

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

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

// If the caret sits inside an "@…" token, return where it starts + the text typed so far. Drives
// the @-mention autocomplete. Returns null when there's no active mention token.
export function detectMention(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      const before = i === 0 ? " " : text[i - 1];
      return /\s/.test(before) ? { start: i, query: text.slice(i + 1, caret) } : null;
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

export const newId = () =>
  (globalThis as any).crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// Coarse relative time: "in 12m", "in 3h", "2d ago"; beyond a week → absolute date. null → "—".
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

export const STATUS_RANK: Record<AgentStatus, number> = {
  working: 0,
  waking: 1,
  idle: 2,
  sleeping: 3,
  offline: 4,
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Working",
  idle: "Idle",
  waking: "Waking up",
  sleeping: "Sleeping",
  offline: "Offline",
};
