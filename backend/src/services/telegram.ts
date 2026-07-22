import { timingSafeEqual } from "node:crypto";

// The Telegram channel provider. Plain Bot API over HTTPS — no SDK, three-function surface
// (configured / send / parse update) mirroring services/imessage.ts so providers stay drop-ins.
//
// Env: LIANA_TELEGRAM_BOT_TOKEN (from @BotFather),
//      LIANA_TELEGRAM_WEBHOOK_SECRET (secret_token passed to setWebhook; Telegram echoes it back
//      on every update in the X-Telegram-Bot-Api-Secret-Token header — that IS the signature).

function botToken(): string {
  return process.env.LIANA_TELEGRAM_BOT_TOKEN ?? "";
}

export function telegramConfigured(): boolean {
  return Boolean(botToken() && process.env.LIANA_TELEGRAM_WEBHOOK_SECRET);
}

export function verifyTelegramWebhook(secretHeader: string | undefined): boolean {
  const secret = process.env.LIANA_TELEGRAM_WEBHOOK_SECRET ?? "";
  if (!secret || !secretHeader) return false;
  const a = Buffer.from(secretHeader);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function api<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await resp.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  if (!resp.ok || !json?.ok) {
    throw new Error(`telegram ${method} failed (${resp.status}): ${json?.description ?? "unknown error"}`);
  }
  return json.result as T;
}

// Bot username for t.me deep links, fetched once per process (it can't change without a new token).
let cachedUsername: string | null = null;
export async function getBotUsername(): Promise<string> {
  if (cachedUsername) return cachedUsername;
  const me = await api<{ username?: string }>("getMe", {});
  if (!me.username) throw new Error("telegram getMe returned no username");
  cachedUsername = me.username;
  return cachedUsername;
}

// Send one message. Tries HTML formatting first (Telegram's least-finicky parse mode); a 400
// from a bad entity falls back to plain text so delivery never dies on formatting. Messages are
// chunked at Telegram's 4096-char limit (split on paragraph/newline boundaries when possible).
export async function sendTelegram(chatId: number | string, markdown: string): Promise<void> {
  if (!telegramConfigured()) throw new Error("Telegram provider not configured");
  const html = mdToTelegramHtml(markdown);
  for (const chunk of chunkText(html, 4000)) {
    try {
      await api("sendMessage", { chat_id: chatId, text: chunk, parse_mode: "HTML", disable_web_page_preview: true });
    } catch {
      await api("sendMessage", { chat_id: chatId, text: stripHtml(chunk) });
    }
  }
}

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// Light markdown (what our agents emit + Slack-style *bold* and <url|label> links from run
// bodies) -> Telegram HTML. Escape first, then reintroduce the few tags Telegram allows.
export function mdToTelegramHtml(md: string): string {
  let s = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/&lt;(https?:[^|]+)\|([^&]+)&gt;/g, '<a href="$1">$2</a>'); // <url|label>
  s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>'); // [label](url)
  s = s.replace(/```([\s\S]*?)```/g, (_, code: string) => `<pre>${code.replace(/^\n|\n$/g, "")}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/gm, "$1<b>$2</b>"); // Slack-style single-star bold
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  s = s.replace(/^\s*[-•]\s+/gm, "• ");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function stripHtml(html: string): string {
  return html
    .replace(/<a href="([^"]+)">([^<]*)<\/a>/g, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Parsed inbound message (private-chat text only; groups, edits, and media are ignored).
export interface TelegramInbound {
  updateId: number;
  chatId: number;
  fromId: number;
  username: string | null;
  text: string;
  startPayload: string | null; // "/start <code>" deep-link payload, null for normal messages
}

export function parseUpdate(payload: Record<string, unknown>): TelegramInbound | null {
  const updateId = payload.update_id;
  const msg = payload.message as Record<string, unknown> | undefined;
  if (typeof updateId !== "number" || !msg) return null;
  const chat = msg.chat as { id?: number; type?: string } | undefined;
  const from = msg.from as { id?: number; username?: string; is_bot?: boolean } | undefined;
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  if (!chat?.id || chat.type !== "private" || !from?.id || from.is_bot || !text) return null;
  const start = /^\/start(?:\s+(\S+))?$/.exec(text);
  return {
    updateId,
    chatId: chat.id,
    fromId: from.id,
    username: from.username ?? null,
    text,
    startPayload: start ? (start[1] ?? "") : null,
  };
}

// Register the webhook with Telegram (called from the routes' one-time setup endpoint is
// overkill — this is invoked at boot when configured, idempotent on Telegram's side).
export async function ensureWebhook(publicUrl: string): Promise<void> {
  await api("setWebhook", {
    url: `${publicUrl.replace(/\/$/, "")}/api/liana/telegram/webhook`,
    secret_token: process.env.LIANA_TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message"],
  });
}
