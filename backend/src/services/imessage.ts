import { createHmac, timingSafeEqual } from "node:crypto";

// The iMessage channel provider. Linq (docs.linqapp.com, Partner API v3) today; the surface is
// deliberately three functions (configured / send / verify+parse webhook) so a SendBlue or other
// provider is a drop-in later — mirror of the Provisioner seam philosophy.
//
// Env: LINQ_API_KEY (Bearer token), LINQ_FROM_NUMBER (E.164 number provisioned by Linq),
//      LINQ_WEBHOOK_SECRET (the subscription's signing secret; `whsec_` prefix optional).

const BASE_URL = process.env.LINQ_BASE_URL ?? "https://api.linqapp.com/api/partner/v3";

function apiKey(): string {
  return process.env.LINQ_API_KEY ?? "";
}
function fromNumber(): string {
  return process.env.LINQ_FROM_NUMBER ?? "";
}

export function imessageConfigured(): boolean {
  return Boolean(apiKey() && fromNumber());
}

// E.164 normalization for user-entered phones. US-biased default (10 digits -> +1), otherwise
// requires a leading +country code. Returns null when it can't make a confident E.164.
export function normalizePhone(raw: string): string | null {
  const cleaned = raw.replace(/[\s().-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(cleaned)) return cleaned;
  if (/^\d{10}$/.test(cleaned)) return `+1${cleaned}`;
  if (/^1\d{10}$/.test(cleaned)) return `+${cleaned}`;
  return null;
}

// Send one text. Linq: POST /chats with from/to/message.parts — for 1:1 chats the (from, to)
// pair addresses the conversation, so this both creates and continues threads.
export async function sendIMessage(toPhone: string, text: string): Promise<void> {
  if (!imessageConfigured()) throw new Error("iMessage provider not configured");
  const resp = await fetch(`${BASE_URL}/chats`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: fromNumber(),
      to: [toPhone],
      message: { parts: [{ type: "text", value: text }] },
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`linq send failed (${resp.status}): ${body.slice(0, 300)}`);
  }
}

// Standard Webhooks verification (Linq uses the spec: HMAC-SHA256 of "{id}.{timestamp}.{body}"
// with the subscription secret; webhook-signature is space-delimited "v1,{base64}" entries).
// Returns false on any mismatch, stale timestamp (>5 min), or missing config/headers.
export function verifyLinqWebhook(
  rawBody: Buffer,
  headers: { id?: string; timestamp?: string; signature?: string },
): boolean {
  const secretRaw = process.env.LINQ_WEBHOOK_SECRET ?? "";
  if (!secretRaw || !headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const key = Buffer.from(secretRaw.replace(/^whsec_/, ""), "base64");
  const signedContent = `${headers.id}.${headers.timestamp}.${rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", key).update(signedContent).digest("base64");
  for (const entry of headers.signature.split(" ")) {
    const [version, sig] = entry.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

// Parsed inbound message (the only event type Liana consumes; everything else is ignored).
export interface InboundText {
  eventId: string;
  fromPhone: string;
  text: string;
  chatId: string | null;
}

// Tolerant extraction of a message.received event. Field names per docs.linqapp.com
// /guides/webhooks/events (sender_handle.handle, parts[].value, chat.id); returns null for
// non-message events, our own outbound echoes, or shapes we don't recognize.
export function parseInboundEvent(payload: Record<string, unknown>, eventId: string): InboundText | null {
  const type = String(payload.type ?? payload.event ?? "");
  if (type && type !== "message.received") return null;
  const data = (payload.data ?? payload) as Record<string, unknown>;
  const sender =
    (data.sender_handle as { handle?: string } | undefined)?.handle ??
    (typeof data.from === "string" ? data.from : undefined);
  if (!sender || sender === fromNumber()) return null;
  const parts = (data.parts ?? (data.message as Record<string, unknown> | undefined)?.parts) as
    | { type?: string; value?: string }[]
    | undefined;
  let text = "";
  if (Array.isArray(parts)) {
    text = parts
      .filter((p) => p?.type === "text" && typeof p.value === "string")
      .map((p) => p.value as string)
      .join(" ")
      .trim();
  } else if (typeof data.text === "string") {
    text = data.text.trim();
  }
  if (!text) return null;
  const chatId = (data.chat as { id?: string } | undefined)?.id ?? null;
  return { eventId, fromPhone: sender, text, chatId };
}

// Markdown -> plain text for the SMS/iMessage bubble: strip the light markdown our agents emit.
export function toPlainText(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/\*([^*]+)\*/g, "$1") // italic/bold-lite
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1") // code
    .replace(/^\s*[-•]\s+/gm, "• ") // bullets
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)") // links
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
