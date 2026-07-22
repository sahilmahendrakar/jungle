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

// A single message carrying an inline keyboard — the draft confirm card (Create it / Cancel).
// Groups can't use typed YES/NO (privacy mode drops bare replies), so the buttons carry the
// workflow id in callback_data. Returns the message id so we can edit the card once acted on.
// Cards are short (name + a few integration lines), so a single un-chunked message is safe.
export interface TelegramButton {
  text: string;
  data: string; // callback_data, <=64 bytes
}
export async function sendTelegramButtons(
  chatId: number | string,
  markdown: string,
  buttons: TelegramButton[],
): Promise<number> {
  if (!telegramConfigured()) throw new Error("Telegram provider not configured");
  const reply_markup = { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] };
  const html = mdToTelegramHtml(markdown);
  try {
    const m = await api<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup,
    });
    return m.message_id;
  } catch {
    const m = await api<{ message_id: number }>("sendMessage", { chat_id: chatId, text: stripHtml(html), reply_markup });
    return m.message_id;
  }
}

// Acknowledge a tapped button (stops Telegram's spinner). Best-effort — a failed ack is cosmetic.
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await api("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }).catch(() => {});
}

// Replace a card's text after it's been acted on, dropping its buttons.
export async function editMessageText(
  chatId: number | string,
  messageId: number,
  markdown: string,
): Promise<void> {
  const html = mdToTelegramHtml(markdown);
  try {
    await api("editMessageText", { chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML", disable_web_page_preview: true });
  } catch {
    await api("editMessageText", { chat_id: chatId, message_id: messageId, text: stripHtml(html) }).catch(() => {});
  }
}

// Show the "typing…" indicator in the chat. It clears on its own after ~5s (or the moment we
// send a message), so a single call before a short intake turn is enough. Best-effort: a typing
// failure must never break the turn.
export async function sendTyping(chatId: number | string): Promise<void> {
  if (!telegramConfigured()) return;
  await api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
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

// Parsed inbound message. Private chats and groups/supergroups (text only; edits and media are
// ignored). Group addressing (was the bot @mentioned / replied to) is decided in the service
// layer, which knows the bot's username — parseUpdate just carries the raw signals.
export interface TelegramInbound {
  updateId: number;
  chatId: number;
  chatType: "private" | "group" | "supergroup";
  isGroup: boolean;
  messageId: number;
  fromId: number;
  username: string | null;
  text: string; // trimmed; @bot mention NOT yet stripped
  replyToBot: boolean; // this message replies to one of the bot's own messages
  startPayload: string | null; // "/start <code>" deep-link payload (private only), null otherwise
}

export function parseUpdate(payload: Record<string, unknown>): TelegramInbound | null {
  const updateId = payload.update_id;
  const msg = payload.message as Record<string, unknown> | undefined;
  if (typeof updateId !== "number" || !msg) return null;
  const chat = msg.chat as { id?: number; type?: string } | undefined;
  const from = msg.from as { id?: number; username?: string; is_bot?: boolean } | undefined;
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  const type = chat?.type;
  const isGroup = type === "group" || type === "supergroup";
  if (!chat?.id || (type !== "private" && !isGroup) || !from?.id || from.is_bot || !text) return null;
  const replyTo = msg.reply_to_message as { from?: { is_bot?: boolean } } | undefined;
  const start = type === "private" ? /^\/start(?:\s+(\S+))?$/.exec(text) : null;
  return {
    updateId,
    chatId: chat.id,
    chatType: type as TelegramInbound["chatType"],
    isGroup,
    messageId: typeof msg.message_id === "number" ? msg.message_id : 0,
    fromId: from.id,
    username: from.username ?? null,
    text,
    replyToBot: Boolean(replyTo?.from?.is_bot),
    startPayload: start ? (start[1] ?? "") : null,
  };
}

// A tapped inline button. callback_data is our own "<action>:<workflowId>" string.
export interface TelegramCallback {
  updateId: number;
  callbackQueryId: string;
  chatId: number;
  messageId: number;
  fromId: number;
  data: string;
}

export function parseCallback(payload: Record<string, unknown>): TelegramCallback | null {
  const updateId = payload.update_id;
  const cq = payload.callback_query as Record<string, unknown> | undefined;
  if (typeof updateId !== "number" || !cq || typeof cq.id !== "string") return null;
  const from = cq.from as { id?: number } | undefined;
  const msg = cq.message as { message_id?: number; chat?: { id?: number } } | undefined;
  const data = typeof cq.data === "string" ? cq.data : "";
  if (!from?.id || !msg?.chat?.id || typeof msg.message_id !== "number" || !data) return null;
  return {
    updateId,
    callbackQueryId: cq.id,
    chatId: msg.chat.id,
    messageId: msg.message_id,
    fromId: from.id,
    data,
  };
}

// Is a group message addressed to us? Privacy mode already narrows group updates to commands,
// replies to us, and @bot mentions — but we double-check so a privacy-off bot doesn't treat all
// group chatter as intake. Returns the text with the leading/embedded @bot mention removed.
export function addressedInGroup(inbound: TelegramInbound, botUsername: string): { addressed: boolean; text: string } {
  const mention = new RegExp(`@${botUsername}\\b`, "ig");
  const mentioned = mention.test(inbound.text);
  const text = inbound.text.replace(new RegExp(`@${botUsername}\\b`, "ig"), " ").replace(/\s+/g, " ").trim();
  return { addressed: mentioned || inbound.replyToBot, text };
}

// Register the webhook with Telegram (called from the routes' one-time setup endpoint is
// overkill — this is invoked at boot when configured, idempotent on Telegram's side).
export async function ensureWebhook(publicUrl: string): Promise<void> {
  await api("setWebhook", {
    url: `${publicUrl.replace(/\/$/, "")}/api/liana/telegram/webhook`,
    secret_token: process.env.LIANA_TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  });
}
