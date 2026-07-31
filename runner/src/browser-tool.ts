// The `browser_*` tools: the agent's way to use a real, logged-in web browser for sites with no
// usable API (LinkedIn, X posting, …). Registered as an in-process SDK MCP server (name "browser")
// alongside "jungle"/"gmail"/"x".
//
// Unlike gmail-tool.ts or x-tool.ts, NOTHING happens in this process. Every verb is forwarded to
// the backend over a browser_tool frame and awaits its correlated browser_tool_result, because the
// only Browserbase credential is a long-lived account API key: there is no short-lived token to
// hand a per-agent container, so the key never leaves the backend. That also means the per-site
// domain allowlist is enforced somewhere this container cannot influence.
//
// Approval: browser_act is routed through the confirmation card when the integration's
// requireApproval is on (runner.ts allowedTools + preToolUseHook). Reads never are.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";

export interface BrowserToolResult {
  ok: boolean;
  error?: string;
  text?: string;
  needsSignin?: boolean;
  requestId?: string;
}

// Injected by the runner: forwards the frame and resolves when the backend replies.
export type BrowserToolBridge = (
  id: string,
  tool: "signin" | "status" | "navigate" | "read" | "act",
  input: {
    site?: string;
    url?: string;
    action?: "click" | "type" | "press";
    target?: string;
    text?: string;
  },
) => Promise<BrowserToolResult>;

// Browser work is slow by nature — a real page load plus a settle delay. Generous relative to the
// other bridges, but still bounded so a wedged session fails the tool instead of the turn.
const BROWSER_TIMEOUT_MS = 90_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for the browser")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function createBrowserMcpServer(bridge: BrowserToolBridge) {
  const call = async (
    verb: "signin" | "status" | "navigate" | "read" | "act",
    input: Parameters<BrowserToolBridge>[2],
  ) => {
    try {
      const r = await withTimeout(bridge(randomUUID(), verb, input), BROWSER_TIMEOUT_MS);
      if (r.ok) return { content: [{ type: "text" as const, text: r.text ?? "Done." }] };
      // needsSignin is the one failure worth steering on: retrying a navigation against a dead
      // session can never succeed, so say plainly what the next move is.
      const hint = r.needsSignin
        ? " Call browser_signin for this site and send the returned link to the account's owner."
        : "";
      return {
        content: [{ type: "text" as const, text: `${r.error ?? "browser call failed"}${hint}` }],
        isError: true,
      };
    } catch (err) {
      log.error(`browser_${verb} failed`, { err: String(err) });
      return {
        content: [
          { type: "text" as const, text: `browser_${verb} failed: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  };

  const site = z.string().describe('Which profile to use, e.g. "linkedin" or "x"');

  const statusTool = tool(
    "browser_status",
    "List the browser profiles you can drive and whether each is signed in and ready. Read-only. " +
      "Check this before assuming you can reach a site.",
    {},
    async () => call("status", {}),
  );

  const signinTool = tool(
    "browser_signin",
    "Ask a human to sign into a site in your cloud browser. Returns a link. You MUST send that " +
      "link to the person who owns the account (with send_message) and wait — only they can open " +
      "it, and only they can complete the login. NEVER ask anyone for a password and never type " +
      "one yourself. Use this when browser_status shows a site is missing or signed out.",
    { site },
    async (args) => call("signin", { site: args.site }),
  );

  const navigateTool = tool(
    "browser_navigate",
    "Open a URL in the logged-in browser and return the page. Only URLs on the profile's own site " +
      "are allowed; anything else is refused. Returns the page title, text and the interactive " +
      "elements you can name in browser_act.",
    { site, url: z.string().describe("Absolute URL to open, on the profile's own site") },
    async (args) => call("navigate", { site: args.site, url: args.url }),
  );

  const readTool = tool(
    "browser_read",
    "Re-read the page currently open in the browser, without navigating. Read-only. Useful after " +
      "an action to see what changed.",
    { site },
    async (args) => call("read", { site: args.site }),
  );

  const actTool = tool(
    "browser_act",
    "Act on the current page: click something, type into a field, or press a key. Describe the " +
      'target the way a person would ("the Connect button", "Search input") — it is matched ' +
      "against the accessible names listed by browser_navigate/browser_read. This can change " +
      "things on a real account, so it may require the owner's approval before it runs.",
    {
      site,
      action: z.enum(["click", "type", "press"]).describe("What to do"),
      target: z
        .string()
        .optional()
        .describe('The element, by its visible or accessible name. Required for click and type.'),
      text: z
        .string()
        .optional()
        .describe('Text to type (action "type"), or the key to press (action "press", e.g. "Enter").'),
    },
    async (args) =>
      call("act", {
        site: args.site,
        action: args.action,
        ...(args.target !== undefined ? { target: args.target } : {}),
        ...(args.text !== undefined ? { text: args.text } : {}),
      }),
  );

  return createSdkMcpServer({
    name: "browser",
    version: "1.0.0",
    tools: [statusTool, signinTool, navigateTool, readTool, actTool],
  });
}

// Read-only browser tools: no confirmation card. browser_navigate is included because every
// reachable URL is already constrained to the profile's own domains by the backend, so it cannot
// be steered somewhere unexpected — the thing worth gating is acting, not looking.
export const BROWSER_READ_TOOLS = [
  "mcp__browser__browser_status",
  "mcp__browser__browser_signin",
  "mcp__browser__browser_navigate",
  "mcp__browser__browser_read",
];

// The write tool, gated on the integration's requireApproval.
export const BROWSER_WRITE_TOOLS = ["mcp__browser__browser_act"];
