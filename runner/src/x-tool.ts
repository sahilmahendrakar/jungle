// The `x_*` custom tools: the agent's way to read activity on a connected X (Twitter) account.
// Registered as an in-process SDK MCP server (name "x"), exactly like the "gmail"/"gdrive" servers
// — no external subprocess. Each tool calls the X API v2 directly with a short-lived OAuth 2.0
// User Context access token, read fresh from `getToken()` on every call so a mid-turn
// `integration_credentials` refresh (key "x", see runner.ts) is picked up without rebuilding.
//
// All tools are read-only (X Basic tier) and auto-allowed — there's nothing to approve, so this
// module knows nothing about the confirmation card (see runner.ts's preToolUseHook + allowedTools).
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { log } from "./log.js";

const API = "https://api.twitter.com/2";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

interface XUser {
  id: string;
  name: string;
  username: string;
}
interface XTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number; quote_count?: number };
  in_reply_to_user_id?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
}
interface XIncludes {
  users?: XUser[];
}
interface XResponse<T> {
  data?: T;
  meta?: { next_token?: string; result_count?: number };
  includes?: XIncludes;
  error?: { message?: string; detail?: string; title?: string };
}

export function createXMcpServer(getToken: () => string | null) {
  // Resolve + cache the authenticated user (id + @handle) on first use. Several endpoints are
  // keyed by user id (/users/:id/tweets, /mentions), and the `to:<username>` search operator needs
  // the bare handle — both come from /users/me, which the token authorizes.
  let meCache: XUser | null = null;
  async function me(): Promise<XUser> {
    if (meCache) return meCache;
    const token = getToken();
    if (!token) throw new Error("X is not connected (no access token).");
    const res = await fetch(`${API}/users/me?user.fields=id,name,username`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as XResponse<XUser>;
    if (!res.ok || !json.data) {
      throw new Error(`x /users/me -> ${res.status}: ${json.error?.message ?? "no data"}`);
    }
    meCache = json.data;
    return meCache;
  }

  // GET an X API v2 endpoint with the current bearer token. Throws with status + body on failure.
  async function xget<T>(path: string): Promise<XResponse<T>> {
    const token = getToken();
    if (!token) throw new Error("X is not connected (no access token).");
    const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const json = (await res.json()) as XResponse<T>;
    if (!res.ok) {
      throw new Error(`x GET ${path} -> ${res.status}: ${json.error?.message ?? json.error?.detail ?? res.statusText}`);
    }
    return json;
  }

  function userById(includes: XIncludes | undefined, id: string | undefined): string {
    if (!id) return "?";
    const u = includes?.users?.find((x) => x.id === id);
    return u ? `@${u.username}` : id;
  }

  // Compact one-line render of a tweet for lists/digests.
  function fmtTweet(t: XTweet, includes?: XIncludes): string {
    const author = t.author_id ? userById(includes, t.author_id) : "";
    const m = t.public_metrics;
    const metrics = m
      ? ` [♥ ${m.like_count ?? 0} 🔁 ${m.retweet_count ?? 0} 💬 ${m.reply_count ?? 0}]`
      : "";
    const when = t.created_at ? ` • ${t.created_at}` : "";
    return `${author ? `${author}: ` : ""}${t.text}${when}${metrics}`;
  }

  // Clamp max_results into X's allowed 5–100 band for timeline/mentions/search endpoints.
  const clamp = (n: number | undefined, dflt: number) => Math.min(100, Math.max(5, n ?? dflt));

  const xMyRecentTweets = tool(
    "x_my_recent_tweets",
    "Fetch your most recent tweets (your own posts). Returns a compact list (text, time, engagement). " +
      "Use this to recap what you've been posting.",
    {
      maxResults: z.number().int().min(5).max(100).optional().describe("How many tweets (default 20, max 100)"),
    },
    async (args) => {
      try {
        const user = await me();
        const n = clamp(args.maxResults, 20);
        const res = await xget<XTweet[]>(
          `/users/${user.id}/tweets?max_results=${n}&tweet.fields=created_at,public_metrics&expansions=author_id&user.fields=username`,
        );
        const tweets = res.data ?? [];
        if (!tweets.length) return ok("You have no recent tweets.");
        return ok(`${tweets.length} recent tweet(s):\n${tweets.map((t) => fmtTweet(t, res.includes)).join("\n")}`);
      } catch (e) {
        log.error("x_my_recent_tweets failed", { err: String(e) });
        return err(`Failed to fetch your tweets: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const xMentions = tool(
    "x_mentions",
    "Fetch recent tweets that @mention you. Returns a compact list (author, text, time, engagement). " +
      "Core signal for an activity digest.",
    {
      maxResults: z.number().int().min(5).max(100).optional().describe("How many tweets (default 25, max 100)"),
    },
    async (args) => {
      try {
        const user = await me();
        const n = clamp(args.maxResults, 25);
        const res = await xget<XTweet[]>(
          `/users/${user.id}/mentions?max_results=${n}&tweet.fields=created_at,author_id,public_metrics&expansions=author_id&user.fields=username`,
        );
        const tweets = res.data ?? [];
        if (!tweets.length) return ok("No recent mentions.");
        return ok(`${tweets.length} mention(s):\n${tweets.map((t) => fmtTweet(t, res.includes)).join("\n")}`);
      } catch (e) {
        log.error("x_mentions failed", { err: String(e) });
        return err(`Failed to fetch mentions: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const xRepliesToMe = tool(
    "x_replies_to_me",
    "Fetch recent tweets that reply to you (the `to:@you` recent search). Returns a compact list " +
      "(author, text, time). Pair with x_mentions for a full incoming-activity picture.",
    {
      maxResults: z.number().int().min(5).max(100).optional().describe("How many tweets (default 25, max 100)"),
    },
    async (args) => {
      try {
        const user = await me();
        const n = clamp(args.maxResults, 25);
        const query = `to:${user.username}`;
        const res = await xget<XTweet[]>(
          `/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${n}` +
            `&tweet.fields=created_at,author_id,public_metrics,in_reply_to_user_id&expansions=author_id&user.fields=username`,
        );
        const tweets = res.data ?? [];
        if (!tweets.length) return ok("No recent replies to you.");
        return ok(`${tweets.length} repl${tweets.length === 1 ? "y" : "ies"} to you:\n${tweets.map((t) => fmtTweet(t, res.includes)).join("\n")}`);
      } catch (e) {
        log.error("x_replies_to_me failed", { err: String(e) });
        return err(`Failed to fetch replies to you: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const xNotifications = tool(
    "x_notifications",
    "Fetch your recent notifications. NOTE: the X notifications endpoint may require a Pro tier " +
      "app; if it errors, use x_mentions + x_replies_to_me instead, which together cover most " +
      "incoming activity on Basic.",
    {
      maxResults: z.number().int().min(5).max(100).optional().describe("How many notifications (default 25, max 100)"),
    },
    async (args) => {
      try {
        const user = await me();
        const n = clamp(args.maxResults, 25);
        const res = await xget<XTweet[]>(
          `/users/${user.id}/notifications?max_results=${n}`,
        );
        const notifs = res.data ?? [];
        if (!notifs.length) return ok("No recent notifications.");
        return ok(`${notifs.length} notification(s):\n${notifs.map((t) => fmtTweet(t, res.includes)).join("\n")}`);
      } catch (e) {
        log.error("x_notifications failed", { err: String(e) });
        return err(`Failed to fetch notifications: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const xSearch = tool(
    "x_search",
    "Search recent public tweets (X recent search, last ~7 days). `query` uses X search operators " +
      "(e.g. 'from:nasa mars', '#AI since:2026-07-01', 'lang:en min_faves:100'). Returns a compact " +
      "list (author, text, time, engagement).",
    {
      query: z.string().describe("X search query, e.g. 'from:nasa mars' or '#agenticAI'"),
      maxResults: z.number().int().min(5).max(100).optional().describe("How many tweets (default 20, max 100)"),
    },
    async (args) => {
      try {
        const n = clamp(args.maxResults, 20);
        const res = await xget<XTweet[]>(
          `/tweets/search/recent?query=${encodeURIComponent(args.query)}&max_results=${n}` +
            `&tweet.fields=created_at,author_id,public_metrics&expansions=author_id&user.fields=username`,
        );
        const tweets = res.data ?? [];
        if (!tweets.length) return ok(`No tweets match ${JSON.stringify(args.query)}.`);
        return ok(`${tweets.length} tweet(s):\n${tweets.map((t) => fmtTweet(t, res.includes)).join("\n")}`);
      } catch (e) {
        log.error("x_search failed", { err: String(e) });
        return err(`Failed to search X: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const xGetUser = tool(
    "x_get_user",
    "Look up a public X user by username (without the @). Returns id, display name, description " +
      "and follower/following counts.",
    { username: z.string().describe("Username to look up, without the leading @") },
    async (args) => {
      try {
        const clean = args.username.replace(/^@/, "");
        const res = await xget<XUser>(
          `/users/by/username/${encodeURIComponent(clean)}?user.fields=id,name,description,public_metrics`,
        );
        const u = res.data;
        if (!u) return err(`No user @${clean}.`);
        const d = u as XUser & {
          description?: string;
          public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number };
        };
        const m = d.public_metrics;
        return ok(
          `@${d.username} (${d.name})\nid: ${d.id}\n${d.description ?? "(no bio)"}\n` +
            `followers: ${m?.followers_count ?? "?"} • following: ${m?.following_count ?? "?"} • tweets: ${m?.tweet_count ?? "?"}`,
        );
      } catch (e) {
        log.error("x_get_user failed", { err: String(e) });
        return err(`Failed to look up user: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "x",
    version: "1.0.0",
    tools: [xMyRecentTweets, xMentions, xRepliesToMe, xNotifications, xSearch, xGetUser],
  });
}
