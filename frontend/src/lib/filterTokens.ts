import type { ActivityFilters } from "../api";

// Client mirror of backend/src/searchFilters.ts: the filter-token language for the Activity
// page's token input and the ⌘K palette's autocomplete. Keep the two grammars in sync — the
// backend still re-parses authoritatively; this one drives chips, pills, and suggestions.

export const KIND_TOKENS = ["pr", "issue", "github", "doc", "drive", "notion", "linear", "granola"] as const;
export const TYPE_TOKENS = ["messages", "deliverables"] as const;
export const IS_TOKENS = ["sent", "received", "mentioned"] as const;

export const KIND_LABELS: Record<string, string> = {
  pr: "PRs",
  issue: "Issues",
  github: "GitHub links",
  doc: "Google Docs",
  drive: "Drive files",
  notion: "Notion pages",
  linear: "Linear issues",
  granola: "Granola notes",
};

// Parse `q` into structured filters + leftover free text. Unknown `key:value` tokens and plain
// words fall through to text (same rule as the backend).
export function parseTokens(q: string): { filters: ActivityFilters; text: string } {
  const filters: ActivityFilters = { type: "all" };
  const text: string[] = [];
  for (const tok of q.trim().split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^([a-z]+):(\S+)$/i);
    if (!m) {
      text.push(tok);
      continue;
    }
    const key = m[1].toLowerCase();
    const raw = m[2];
    const bare = raw.replace(/^[@#]+/, "").toLowerCase();
    switch (key) {
      case "from":
        filters.from = bare;
        break;
      case "to":
        filters.to = bare;
        break;
      case "in":
        if (raw.startsWith("@")) filters.inDm = bare;
        else filters.inChannel = bare;
        break;
      case "is":
        if (raw.toLowerCase() === "sent") filters.direction = "sent";
        else if (raw.toLowerCase() === "received") filters.direction = "received";
        else if (raw.toLowerCase() === "mention" || raw.toLowerCase() === "mentioned")
          filters.direction = "mentions";
        else text.push(tok);
        break;
      case "type":
        if (/^messages?$/i.test(raw)) filters.type = "messages";
        else if (/^deliverables?$/i.test(raw)) filters.type = "deliverables";
        else text.push(tok);
        break;
      case "kind":
        if ((KIND_TOKENS as readonly string[]).includes(bare)) filters.kind = bare;
        else text.push(tok);
        break;
      default:
        text.push(tok);
    }
  }
  return { filters, text: text.join(" ").trim() };
}

// The token under the caret, if it looks like an in-progress filter ("from:ec", "in:#gen").
// Used to drive the suggestion popup; returns the key, the partial value, and the token's span
// so a chosen suggestion can splice itself in.
export function tokenAtCaret(
  input: string,
  caret: number,
): { key: string; value: string; start: number; end: number } | null {
  let start = caret;
  while (start > 0 && !/\s/.test(input[start - 1])) start--;
  let end = caret;
  while (end < input.length && !/\s/.test(input[end])) end++;
  const word = input.slice(start, end);
  const m = word.match(/^(from|to|in|type|kind|is):(\S*)$/i);
  if (!m) return null;
  return { key: m[1].toLowerCase(), value: m[2], start, end };
}

// A chip's display label for an active filter field (the removable pills under the filter bar).
export function chipLabel(key: string, value: string): string {
  switch (key) {
    case "from":
      return `from:@${value}`;
    case "to":
      return `to:@${value}`;
    case "person":
      return `person:@${value}`;
    case "inChannel":
      return `in:#${value}`;
    case "inDm":
      return `in:@${value}`;
    case "kind":
      return `kind:${value}`;
    default:
      return `${key}:${value}`;
  }
}
