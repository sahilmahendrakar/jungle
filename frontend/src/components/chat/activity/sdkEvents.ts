// Pure parsing for the agent Activity transcript: raw Claude Agent SDK stream events -> a flat,
// renderable item model, grouped into turns. No React here. The SDK event shapes are loosely typed
// (they vary by version), so everything narrows defensively off a `type` discriminant.
import type { AgentEvent } from "../../../api";

// ---- Raw SDK event shapes (defensive; only the fields we read) ----

interface SdkTextBlock {
  type: "text";
  text?: string;
}
interface SdkThinkingBlock {
  type: "thinking";
  thinking?: string;
}
interface SdkToolUseBlock {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: unknown;
}
interface SdkToolResultBlock {
  type: "tool_result";
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
type SdkBlock =
  | SdkTextBlock
  | SdkThinkingBlock
  | SdkToolUseBlock
  | SdkToolResultBlock
  | { type?: string; [k: string]: unknown };

interface SdkSystemEvent {
  type: "system";
  subtype?: string;
  description?: string;
  status?: string;
  summary?: string;
}
interface SdkAssistantEvent {
  type: "assistant";
  message?: { content?: unknown };
}
interface SdkUserEvent {
  type: "user";
  message?: { content?: unknown };
}
interface SdkResultEvent {
  type: "result";
  is_error?: boolean;
  subtype?: string;
  result?: unknown;
  duration_ms?: number;
  total_cost_usd?: number;
}
type SdkEvent =
  | SdkSystemEvent
  | SdkAssistantEvent
  | SdkUserEvent
  | SdkResultEvent
  | { type?: string; [k: string]: unknown };

// ---- Renderable item model ----

export interface ToolResultInfo {
  text: string;
  isError: boolean;
}
export interface ToolItem {
  kind: "tool";
  key: string;
  name: string;
  input: unknown;
  result: ToolResultInfo | null;
}
export interface TextItem {
  kind: "text";
  key: string;
  text: string;
}
export interface ThinkingItem {
  kind: "thinking";
  key: string;
  text: string;
}
export interface NoteItem {
  kind: "note";
  key: string;
  text: string;
}
export interface ResultItem {
  kind: "result";
  key: string;
  ok: boolean;
  text?: string;
  durationMs?: number;
  cost?: number;
}
export interface RawItem {
  kind: "raw";
  key: string;
  value: unknown;
}
// A message that fed this agent from outside its own turn loop: the trigger that woke it,
// a `/compact` request, or another message delivered to its inbox mid-turn.
export interface InboundItem {
  kind: "inbound";
  key: string;
  source: "trigger" | "inbox" | "compact";
  text: string;
}
export type Item =
  | ToolItem
  | TextItem
  | ThinkingItem
  | NoteItem
  | ResultItem
  | RawItem
  | InboundItem;

export interface Turn {
  turnId: string;
  events: AgentEvent[];
}

// ---- Small value helpers ----

export function pretty(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export const CLIP = 96;
export function clip(s: string | undefined): string {
  if (!s) return "";
  const line = s.split("\n")[0];
  return line.length > CLIP ? `${line.slice(0, CLIP)}…` : line;
}

export function baseName(p: unknown): string {
  const s = String(p ?? "");
  const ix = s.lastIndexOf("/");
  return ix >= 0 ? s.slice(ix + 1) : s;
}

// Read a string field off an arbitrary (unknown) tool-input object; "" when absent/non-string.
export function inputStr(input: unknown, key: string): string {
  const v = input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" ? v : "";
}
// Like inputStr but returns undefined when absent (for "is this field present?" checks).
export function inputField(input: unknown, key: string): string | undefined {
  const v = input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" ? v : undefined;
}
// The first non-empty string value in an input object (a generic "target" fallback).
export function firstString(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const v of Object.values(input)) if (typeof v === "string" && v.trim()) return v;
  return undefined;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c) => (typeof c === "string" ? c : ((c as { text?: string })?.text ?? pretty(c))))
      .join("\n");
  return pretty(content);
}

// ---- Turn grouping + item building ----

// Merge event pages / live frames by id, keeping ascending (oldest-first) order.
export function mergeEvents(a: AgentEvent[], b: AgentEvent[]): AgentEvent[] {
  const map = new Map<number, AgentEvent>();
  for (const e of [...a, ...b]) map.set(e.id, e);
  return [...map.values()].sort((x, y) => x.id - y.id);
}

// Group ascending events into turns (turn_id), preserving first-seen order.
export function groupTurns(events: AgentEvent[]): Turn[] {
  const out: Turn[] = [];
  const byId = new Map<string, Turn>();
  for (const e of events) {
    const key = e.turn_id ?? "—";
    let t = byId.get(key);
    if (!t) {
      t = { turnId: key, events: [] };
      byId.set(key, t);
      out.push(t);
    }
    t.events.push(e);
  }
  return out;
}

// A turn is worth showing only if it produces at least one renderable transcript item.
// SDK agents emit many hidden events (thinking_tokens, task_progress, tool_result updates)
// that merge into turns but create no visible rows, so callers can filter empty turns.
export function turnHasVisibleItems(turn: Turn): boolean {
  return buildItems(turn.events).length > 0;
}

export function countVisibleTurns(events: AgentEvent[]): number {
  return groupTurns(events).filter(turnHasVisibleItems).length;
}

// System subtypes that are pure noise in a human transcript.
const HIDDEN_SYSTEM = new Set(["thinking_tokens", "task_progress", "task_updated"]);

// Flatten a turn's raw SDK events into renderable items. Tool calls are paired with their
// tool_result (by tool_use_id) so each call renders as a single row with a live status.
export function buildItems(events: AgentEvent[]): Item[] {
  const items: Item[] = [];
  const byToolUseId = new Map<string, ToolItem>();
  for (const e of events) {
    const ev = e.event as SdkEvent | null | undefined;
    const type = ev?.type;

    if (type === "jungle_inbound") {
      const inbound = ev as { source?: string; text?: string };
      const source = inbound.source === "compact" || inbound.source === "inbox" ? inbound.source : "trigger";
      items.push({ kind: "inbound", key: `${e.id}`, source, text: String(inbound.text ?? "") });
      continue;
    }

    if (type === "system") {
      const sys = ev as SdkSystemEvent;
      const st = String(sys.subtype ?? "");
      if (HIDDEN_SYSTEM.has(st)) continue;
      if (st === "init") items.push({ kind: "note", key: `${e.id}`, text: "Session started" });
      else if (st === "task_started")
        items.push({
          kind: "note",
          key: `${e.id}`,
          text: `Background task started${sys.description ? ` — ${sys.description}` : ""}`,
        });
      else if (st === "task_notification")
        items.push({
          kind: "note",
          key: `${e.id}`,
          text: `Background task ${sys.status ?? "update"}${sys.summary ? ` — ${sys.summary}` : ""}`,
        });
      else items.push({ kind: "note", key: `${e.id}`, text: st || "system" });
      continue;
    }

    if (type === "assistant") {
      const blocks = (ev as SdkAssistantEvent).message?.content;
      if (!Array.isArray(blocks)) {
        items.push({ kind: "raw", key: `${e.id}`, value: ev });
        continue;
      }
      (blocks as SdkBlock[]).forEach((b, i) => {
        const key = `${e.id}:${i}`;
        if (b?.type === "text") {
          const text = String((b as SdkTextBlock).text ?? "");
          if (text.trim()) items.push({ kind: "text", key, text });
        } else if (b?.type === "thinking") {
          const text = String((b as SdkThinkingBlock).thinking ?? "");
          if (text.trim()) items.push({ kind: "thinking", key, text });
        } else if (b?.type === "tool_use") {
          const tb = b as SdkToolUseBlock;
          const t: ToolItem = {
            kind: "tool",
            key,
            name: String(tb.name ?? "tool"),
            input: tb.input ?? {},
            result: null,
          };
          items.push(t);
          if (tb.id) byToolUseId.set(String(tb.id), t);
        } else {
          items.push({ kind: "raw", key, value: b });
        }
      });
      continue;
    }

    if (type === "user") {
      const blocks = (ev as SdkUserEvent).message?.content;
      if (Array.isArray(blocks)) {
        (blocks as SdkBlock[]).forEach((b, i) => {
          if (b?.type !== "tool_result") return;
          const rb = b as SdkToolResultBlock;
          const res: ToolResultInfo = {
            text: resultText(rb.content),
            isError: rb.is_error === true,
          };
          const t = rb.tool_use_id ? byToolUseId.get(String(rb.tool_use_id)) : undefined;
          if (t) t.result = res;
          else
            items.push({
              kind: "tool",
              key: `${e.id}:${i}`,
              name: "tool",
              input: null,
              result: res,
            });
        });
      }
      continue;
    }

    if (type === "result") {
      const r = ev as SdkResultEvent;
      items.push({
        kind: "result",
        key: `${e.id}`,
        ok: r.is_error !== true && (r.subtype ?? "success") === "success",
        text: typeof r.result === "string" ? r.result : undefined,
        durationMs: typeof r.duration_ms === "number" ? r.duration_ms : undefined,
        cost: typeof r.total_cost_usd === "number" ? r.total_cost_usd : undefined,
      });
      continue;
    }

    items.push({ kind: "raw", key: `${e.id}`, value: ev });
  }
  return items;
}

// Short scannable summary for a collapsed turn header.
export function turnSummary(items: Item[]): string {
  const lastText = [...items].reverse().find((i) => i.kind === "text") as TextItem | undefined;
  if (lastText) return clip(lastText.text.replace(/[#*`>]/g, "").trim());
  const tools = items.filter((i) => i.kind === "tool").length;
  if (tools > 0) return `${tools} action${tools === 1 ? "" : "s"}`;
  const note = items.find((i) => i.kind === "note") as NoteItem | undefined;
  return note?.text ?? "";
}

// "mcp__jungle__send_message" -> "send message"; PascalCase tool names stay as-is.
function humanToolName(name: string): string {
  const mcp = name.match(/^mcp__.+?__(.+)$/);
  return (mcp ? mcp[1] : name).replace(/_/g, " ");
}

// What the agent is doing RIGHT NOW, for the ambient one-line working indicator: the still-
// running tool call if there is one, else the freshest thinking/text tail.
export function liveSummary(items: Item[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && !it.result) return `running ${humanToolName(it.name)}`;
    if (it.kind === "tool") return `ran ${humanToolName(it.name)}`;
    if (it.kind === "thinking") return "thinking…";
    if (it.kind === "text") return clip(it.text.replace(/[#*`>]/g, "").trim());
  }
  return "getting started…";
}
