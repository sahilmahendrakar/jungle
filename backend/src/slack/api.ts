// Minimal Slack Web API client (hand-rolled fetch, matching the house style of google.ts/github.ts).
// Only the ~7 methods the bridge needs. We deliberately do NOT use @slack/web-api: its built-in
// retry/rate-limit queue would swallow the 429s that our outbox ticker needs to see and act on.
//
// SLACK_API_BASE overrides the endpoint for stub testing (mirrors ANTHROPIC_API_BASE in llm.ts).

const SLACK_API = (process.env.SLACK_API_BASE ?? "https://slack.com/api").replace(/\/$/, "");

export class SlackApiError extends Error {
  constructor(
    public code: string,
    public retryAfterSec?: number,
  ) {
    super(`slack api error: ${code}`);
    this.name = "SlackApiError";
  }
}

// Fatal (non-retryable) Slack error codes for a linked channel — the bridge parks the link on these.
export const FATAL_SLACK_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "no_permission",
  "restricted_action",
]);

// Auth/token errors that mean the whole install is dead, not just one link.
export const AUTH_SLACK_ERRORS = new Set(["invalid_auth", "token_revoked", "account_inactive"]);

interface SlackResponse {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

// Core call. token null => no Authorization header (oauth.v2.access authenticates by client creds
// in the body). Throws SlackApiError on HTTP 429 or a { ok: false } response.
async function slackCall(
  method: string,
  token: string | null,
  params: Record<string, unknown>,
  // Form-encoding is the default because it works for EVERY Web API method; some read methods
  // (e.g. conversations.info) reject a JSON body with invalid_arguments. Opt into JSON only when a
  // param is a nested object (chat.postMessage's metadata/blocks).
  asJson = false,
): Promise<SlackResponse> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  let body: string;
  if (asJson) {
    headers["content-type"] = "application/json; charset=utf-8";
    body = JSON.stringify(params);
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      form.set(k, typeof v === "string" ? v : String(v));
    }
    body = form.toString();
  }
  const resp = await fetch(`${SLACK_API}/${method}`, { method: "POST", headers, body });
  if (resp.status === 429) {
    const retryAfter = Number(resp.headers.get("retry-after") ?? "1");
    throw new SlackApiError("rate_limited", Number.isFinite(retryAfter) ? retryAfter : 1);
  }
  const json = (await resp.json()) as SlackResponse;
  if (!json.ok) throw new SlackApiError(json.error ?? "unknown_error");
  return json;
}

// --- OAuth ---

export interface OAuthV2Result {
  access_token: string;
  scope: string;
  bot_user_id: string;
  team: { id: string; name?: string };
}

export async function oauthV2Access(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<OAuthV2Result> {
  const r = await slackCall(
    "oauth.v2.access",
    null,
    {
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    },
  );
  return r as unknown as OAuthV2Result;
}

export async function authTest(token: string): Promise<{ user_id: string; bot_id?: string; team_id: string }> {
  const r = await slackCall("auth.test", token, {});
  return r as unknown as { user_id: string; bot_id?: string; team_id: string };
}

// --- Messaging ---

export interface PostMessageArgs {
  channel: string;
  text: string;
  username?: string;
  iconUrl?: string | null;
  threadTs?: string | null;
  replyBroadcast?: boolean;
  metadata?: { event_type: string; event_payload: Record<string, unknown> };
}

export async function chatPostMessage(token: string, args: PostMessageArgs): Promise<{ ts: string }> {
  const params: Record<string, unknown> = {
    channel: args.channel,
    text: args.text,
  };
  if (args.username) params.username = args.username;
  if (args.iconUrl) params.icon_url = args.iconUrl;
  if (args.threadTs) params.thread_ts = args.threadTs;
  if (args.replyBroadcast) params.reply_broadcast = true;
  if (args.metadata) params.metadata = args.metadata;
  // JSON body: metadata is a nested object that can't be form-encoded.
  const r = await slackCall("chat.postMessage", token, params, true);
  return { ts: String(r.ts) };
}

// --- Conversations ---

export interface SlackConversation {
  id: string;
  name: string;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
}

// Public channels the bot can see, following cursor pagination (guarded against runaway loops).
export async function conversationsList(token: string): Promise<SlackConversation[]> {
  const out: SlackConversation[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const params: Record<string, unknown> = {
      types: "public_channel",
      exclude_archived: true,
      limit: 200,
    };
    if (cursor) params.cursor = cursor;
    const r = await slackCall("conversations.list", token, params);
    out.push(...((r.channels as SlackConversation[]) ?? []));
    cursor = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

export async function conversationsJoin(token: string, channel: string): Promise<void> {
  await slackCall("conversations.join", token, { channel });
}

export async function conversationsInfo(token: string, channel: string): Promise<SlackConversation> {
  const r = await slackCall("conversations.info", token, { channel });
  return r.channel as SlackConversation;
}

// --- Users ---

export interface SlackUserProfile {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  isBot: boolean;
}

export async function usersInfo(token: string, user: string): Promise<SlackUserProfile> {
  const r = await slackCall("users.info", token, { user });
  const u = r.user as {
    id: string;
    name?: string;
    real_name?: string;
    is_bot?: boolean;
    profile?: { display_name?: string; real_name?: string; email?: string; image_192?: string; image_512?: string };
  };
  const p = u.profile ?? {};
  return {
    id: u.id,
    displayName: p.display_name || p.real_name || u.real_name || u.name || u.id,
    email: p.email || null,
    avatarUrl: p.image_512 || p.image_192 || null,
    isBot: !!u.is_bot,
  };
}
