// A paste with more lines than this is abbreviated to a placeholder chip in the composer
// instead of being inserted inline.
export const PASTE_LINE_THRESHOLD = 5;

export function countLines(text: string): number {
  return text.split("\n").length;
}

export function pasteLabel(id: number, lines: number): string {
  return `[Pasted text #${id} +${lines} lines]`;
}

const PLACEHOLDER_RE = /\[Pasted text #(\d+) \+(\d+) lines\]/g;
const BLOCK_RE = /<!--pasted-text:(\d+)-->\n([\s\S]*?)\n<!--\/pasted-text-->/g;

// The full pasted text rides along in a hidden trailer block appended after the visible
// body, keyed by paste id, so recipients can render the placeholder as an expandable chip.
export function appendPasteBlock(body: string, id: number, content: string): string {
  return `${body}\n<!--pasted-text:${id}-->\n${content}\n<!--/pasted-text-->`;
}

export interface ParsedMessageBody {
  text: string;
  pastes: Map<number, string>;
}

export function extractPasteBlocks(body: string): ParsedMessageBody {
  const pastes = new Map<number, string>();
  const text = body
    .replace(BLOCK_RE, (_match, id, content) => {
      pastes.set(Number(id), content);
      return "";
    })
    .trimEnd();
  return { text, pastes };
}

export type BodyPart = { type: "text"; value: string } | { type: "paste"; id: number; lines: number };

export function splitPastePlaceholders(text: string): BodyPart[] {
  const parts: BodyPart[] = [];
  let lastIndex = 0;
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const idx = m.index ?? 0;
    if (idx > lastIndex) parts.push({ type: "text", value: text.slice(lastIndex, idx) });
    parts.push({ type: "paste", id: Number(m[1]), lines: Number(m[2]) });
    lastIndex = idx + m[0].length;
  }
  if (lastIndex < text.length) parts.push({ type: "text", value: text.slice(lastIndex) });
  return parts;
}
