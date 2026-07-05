// The `gmail_*` custom tools: the agent's way to act on a connected Gmail mailbox. Registered as
// a second in-process SDK MCP server (name "gmail"), exactly like the "jungle" server in
// send-message-tool.ts — no external subprocess. Each tool calls the Gmail REST API v1 directly
// with a short-lived OAuth access token. The token is read fresh from `getToken()` on every call,
// so a mid-turn `gmail_credentials` refresh (see runner.ts) is picked up without rebuilding.
//
// Read/search tools are auto-allowed; the write tools (send / draft / modify) are gated through
// the human confirmation card when the integration's requireSendApproval is on (see runner.ts's
// preToolUseHook + allowedTools). This module doesn't know about that gating — it just does the work.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { log } from "./log.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export function createGmailMcpServer(getToken: () => string | null) {
  // Call the Gmail API with the current access token. Throws with the status + body on failure.
  async function gapi<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = getToken();
    if (!token) throw new Error("Gmail is not connected (no access token).");
    const res = await fetch(API + path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`gmail ${init.method ?? "GET"} ${path} -> ${res.status}: ${body.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }

  const gmailSearch = tool(
    "gmail_search",
    "Search the connected Gmail mailbox. `query` uses Gmail's search syntax (e.g. " +
      '"from:alice newer_than:7d", "subject:invoice is:unread"). Returns a compact list of matching ' +
      "messages (id, date, from, subject, snippet); use gmail_read_message with an id to read one in full.",
    {
      query: z.string().describe("Gmail search query, e.g. 'from:alice is:unread newer_than:7d'"),
      maxResults: z.number().int().min(1).max(25).optional().describe("Max messages to return (default 10, max 25)"),
    },
    async (args) => {
      try {
        const n = args.maxResults ?? 10;
        const list = await gapi<{ messages?: Array<{ id: string }> }>(
          `/messages?q=${encodeURIComponent(args.query)}&maxResults=${n}`,
        );
        const ids = (list.messages ?? []).slice(0, n);
        if (!ids.length) return ok(`No messages match ${JSON.stringify(args.query)}.`);
        const lines: string[] = [];
        for (const { id } of ids) {
          const msg = await gapi<GmailMessage>(
            `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          );
          const hs = msg.payload?.headers ?? [];
          lines.push(
            `- id:${id} • ${header(hs, "Date")} • from ${header(hs, "From")} • ${header(hs, "Subject") || "(no subject)"}` +
              (msg.snippet ? `\n    ${msg.snippet}` : ""),
          );
        }
        return ok(`${ids.length} message(s):\n${lines.join("\n")}`);
      } catch (e) {
        log.error("gmail_search failed", { err: String(e) });
        return err(`Failed to search Gmail: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const gmailReadMessage = tool(
    "gmail_read_message",
    "Read one Gmail message in full by its id (from gmail_search). Returns the headers and the " +
      "plain-text body.",
    { id: z.string().describe("The message id, as returned by gmail_search") },
    async (args) => {
      try {
        const msg = await gapi<GmailMessage>(`/messages/${args.id}?format=full`);
        const hs = msg.payload?.headers ?? [];
        const body = decodeBody(msg.payload) || msg.snippet || "(no text body)";
        return ok(
          `From: ${header(hs, "From")}\nTo: ${header(hs, "To")}\nDate: ${header(hs, "Date")}\n` +
            `Subject: ${header(hs, "Subject")}\n\n${body}`,
        );
      } catch (e) {
        log.error("gmail_read_message failed", { err: String(e) });
        return err(`Failed to read message: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const gmailSend = tool(
    "gmail_send",
    "Send a new email from the connected Gmail account. Depending on the integration's settings " +
      "this may require a human's approval before it actually sends.",
    {
      to: z.string().describe("Recipient address(es), comma-separated"),
      subject: z.string().describe("Subject line"),
      body: z.string().describe("Plain-text body"),
      cc: z.string().optional().describe("Cc address(es), comma-separated"),
      bcc: z.string().optional().describe("Bcc address(es), comma-separated"),
    },
    async (args) => {
      try {
        const raw = buildRaw(args);
        const sent = await gapi<{ id: string }>(`/messages/send`, {
          method: "POST",
          body: JSON.stringify({ raw }),
        });
        return ok(`Email sent to ${args.to} (message id ${sent.id}).`);
      } catch (e) {
        log.error("gmail_send failed", { err: String(e) });
        return err(`Failed to send email: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const gmailCreateDraft = tool(
    "gmail_create_draft",
    "Save a draft email in the connected Gmail account (does not send it).",
    {
      to: z.string().describe("Recipient address(es), comma-separated"),
      subject: z.string().describe("Subject line"),
      body: z.string().describe("Plain-text body"),
      cc: z.string().optional().describe("Cc address(es), comma-separated"),
    },
    async (args) => {
      try {
        const raw = buildRaw(args);
        const draft = await gapi<{ id: string }>(`/drafts`, {
          method: "POST",
          body: JSON.stringify({ message: { raw } }),
        });
        return ok(`Draft saved (draft id ${draft.id}).`);
      } catch (e) {
        log.error("gmail_create_draft failed", { err: String(e) });
        return err(`Failed to create draft: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const gmailModifyLabels = tool(
    "gmail_modify_labels",
    "Add and/or remove labels on a Gmail message — used to archive (remove INBOX), mark read " +
      "(remove UNREAD), star (add STARRED), etc. Label ids are Gmail's system labels " +
      "(INBOX, UNREAD, STARRED, IMPORTANT, TRASH, SPAM) or custom label ids.",
    {
      id: z.string().describe("The message id (from gmail_search)"),
      addLabelIds: z.array(z.string()).optional().describe("Label ids to add"),
      removeLabelIds: z.array(z.string()).optional().describe("Label ids to remove"),
    },
    async (args) => {
      try {
        if (!args.addLabelIds?.length && !args.removeLabelIds?.length) {
          return err("Provide at least one label to add or remove.");
        }
        await gapi(`/messages/${args.id}/modify`, {
          method: "POST",
          body: JSON.stringify({
            addLabelIds: args.addLabelIds ?? [],
            removeLabelIds: args.removeLabelIds ?? [],
          }),
        });
        return ok(`Updated labels on message ${args.id}.`);
      } catch (e) {
        log.error("gmail_modify_labels failed", { err: String(e) });
        return err(`Failed to modify labels: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "gmail",
    version: "1.0.0",
    tools: [gmailSearch, gmailReadMessage, gmailSend, gmailCreateDraft, gmailModifyLabels],
  });
}

// ---- Gmail REST helpers ----

interface GmailMessagePart {
  mimeType?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string };
  parts?: GmailMessagePart[];
}
interface GmailMessage {
  snippet?: string;
  payload?: GmailMessagePart;
}

function header(headers: Array<{ name?: string; value?: string }>, name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// Depth-first walk of the MIME tree for the first text/plain body; Gmail base64url-encodes it.
function decodeBody(payload: GmailMessagePart | undefined): string {
  if (!payload) return "";
  const walk = (p: GmailMessagePart): string | null => {
    if (p.mimeType === "text/plain" && p.body?.data) {
      return Buffer.from(p.body.data, "base64url").toString("utf8");
    }
    for (const part of p.parts ?? []) {
      const r = walk(part);
      if (r) return r;
    }
    return null;
  };
  return walk(payload) ?? "";
}

// Build an RFC 2822 message and base64url-encode it for the Gmail `raw` field.
function buildRaw(fields: { to: string; subject: string; body: string; cc?: string; bcc?: string }): string {
  const headers = [
    `To: ${fields.to}`,
    fields.cc ? `Cc: ${fields.cc}` : "",
    fields.bcc ? `Bcc: ${fields.bcc}` : "",
    `Subject: ${encodeHeaderWord(fields.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ].filter(Boolean);
  const msg = headers.join("\r\n") + "\r\n\r\n" + fields.body;
  return Buffer.from(msg, "utf8").toString("base64url");
}

// RFC 2047 encoded-word so non-ASCII subjects survive header transport.
function encodeHeaderWord(s: string): string {
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}
