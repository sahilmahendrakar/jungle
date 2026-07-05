// The `send_message` and `read_history` custom tools: the agent's ways to speak to and read
// context from Jungle. Registered as an in-process SDK MCP server (name "jungle"), auto-allowed
// via allowedTools. send_message uploads any `files` (workspace paths) to the backend first,
// then forwards a `send_message` frame referencing the upload ids and awaits the matching
// `send_message_result`. read_history forwards a `read_history` frame and awaits
// `read_history_result` — it's read-only, so it's also listed in SAFE_TOOLS (no confirmation).
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";
import { MAX_FILES_PER_MESSAGE, type UploadedAttachment } from "./files.js";

export interface SendMessageResult {
  ok: boolean;
  error?: string;
  messageId?: string;
}

export interface ReadHistoryResult {
  ok: boolean;
  error?: string;
  text?: string;
  oldestSeq?: string | null;
}

export interface ScheduleCreateResult {
  ok: boolean;
  error?: string;
  scheduleId?: string;
  nextRunAt?: string;
}

export interface ScheduleListResult {
  ok: boolean;
  error?: string;
  text?: string;
}

export interface ScheduleCancelResult {
  ok: boolean;
  error?: string;
}

// Injected by the runner: forwards the frame and returns a promise resolved when
// the backend replies with send_message_result (or rejected/timed out).
export type SendMessageBridge = (
  id: string,
  input: {
    to: string;
    body: string;
    attachmentIds?: string[];
    threadRootId?: string | null;
    alsoToChannel?: boolean;
  },
) => Promise<SendMessageResult>;

// Injected by the runner: forwards the frame and returns a promise resolved when the backend
// replies with read_history_result (or rejected/timed out).
export type ReadHistoryBridge = (
  id: string,
  input: {
    to: string;
    threadRootId?: string;
    beforeSeq?: string;
    limit?: number;
  },
) => Promise<ReadHistoryResult>;

// Injected by the runner: forward a schedule_* frame and await its result. Same id-correlated
// round-trip as the other bridges.
export type ScheduleCreateBridge = (
  id: string,
  input: { prompt: string; cron?: string; timezone?: string; runAt?: string; channel?: string },
) => Promise<ScheduleCreateResult>;
export type ScheduleListBridge = (id: string) => Promise<ScheduleListResult>;
export type ScheduleCancelBridge = (
  id: string,
  input: { scheduleId: string },
) => Promise<ScheduleCancelResult>;

// Injected by the runner: uploads one workspace file to the backend, returning its
// attachment id. Throws with a human-readable message on failure.
export type FileUploader = (filePath: string) => Promise<UploadedAttachment>;

const SEND_TIMEOUT_MS = 60_000;

// All the backend round-trips the jungle tools need, injected by the runner.
export interface JungleBridges {
  sendMessage: SendMessageBridge;
  uploadFile: FileUploader;
  readHistory: ReadHistoryBridge;
  scheduleCreate: ScheduleCreateBridge;
  scheduleList: ScheduleListBridge;
  scheduleCancel: ScheduleCancelBridge;
}

export function createJungleMcpServer(bridges: JungleBridges) {
  const { sendMessage: bridge, uploadFile, readHistory } = bridges;
  const sendMessage = tool(
    "send_message",
    "Send a chat message to a Jungle channel or user. This is the ONLY way to " +
      "communicate with people; plain assistant text is never shown to users. " +
      "`to` is a channel like \"#general\" or a handle like \"@alice\". " +
      "Attach files from your workspace with `files` (absolute or workspace-relative " +
      "paths, max 10 × 25MB); images render inline in the chat.",
    {
      to: z.string().describe('Destination: "#channel" or "@handle"'),
      body: z.string().describe("The message text to post"),
      files: z
        .array(z.string())
        .max(MAX_FILES_PER_MESSAGE)
        .optional()
        .describe("Workspace file paths to attach (images render inline in the chat)"),
      threadRootId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Reply inside a thread, by the root message's id. Usually omit this: when you were " +
            "addressed in a thread your reply is placed there automatically. Set it explicitly " +
            "to start/continue a specific thread you know the root id of, or pass null to force " +
            "a top-level post even when you were addressed inside a thread.",
        ),
      alsoToChannel: z
        .boolean()
        .optional()
        .describe(
          "When replying in a thread, also post the reply to the main channel timeline " +
            "(Slack's 'also send to channel'). Ignored for non-thread messages.",
        ),
    },
    async (args) => {
      const id = randomUUID();
      try {
        // Upload first; any failure aborts the send so the agent can fix the path/size
        // rather than silently posting without the file it promised.
        const attachmentIds: string[] = [];
        for (const f of (args.files ?? []).slice(0, MAX_FILES_PER_MESSAGE)) {
          const up = await uploadFile(f);
          attachmentIds.push(up.id);
        }
        const result = await withTimeout(
          bridge(id, {
            to: args.to,
            body: args.body,
            ...(attachmentIds.length ? { attachmentIds } : {}),
            // Forward an explicit null (force top-level) too — only a truly omitted field
            // should fall through to the backend's "default to the triggering thread" behavior.
            ...(args.threadRootId !== undefined ? { threadRootId: args.threadRootId } : {}),
            ...(args.alsoToChannel ? { alsoToChannel: true } : {}),
          }),
          SEND_TIMEOUT_MS,
        );
        if (result.ok) {
          const attached = attachmentIds.length ? ` with ${attachmentIds.length} file(s)` : "";
          return {
            content: [
              {
                type: "text",
                text: `Message sent to ${args.to}${attached}${
                  result.messageId ? ` (id ${result.messageId})` : ""
                }.`,
              },
            ],
          };
        }
        return {
          content: [
            { type: "text", text: `Failed to send message: ${result.error ?? "unknown error"}` },
          ],
          isError: true,
        };
      } catch (err) {
        log.error("send_message tool failed", { err: String(err) });
        return {
          content: [
            {
              type: "text",
              text: `Failed to send message to ${args.to}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  const readHistoryTool = tool(
    "read_history",
    "Read further back into a Jungle channel or DM's message history than what's inlined in " +
      "your turn prompt (only the last few messages are included there). Read-only. `to` is a " +
      "channel like \"#general\" or a handle like \"@alice\", same as send_message. Returns the " +
      "requested page oldest-first, plus `oldestSeq` to pass back as `beforeSeq` for the next " +
      "page further back (omit `beforeSeq` for the most recent page).",
    {
      to: z.string().describe('Destination: "#channel" or "@handle"'),
      threadRootId: z
        .string()
        .optional()
        .describe(
          "Read a specific thread's transcript (root + replies) instead of the channel's " +
            "top-level timeline, by the thread root message's id.",
        ),
      beforeSeq: z
        .string()
        .optional()
        .describe("Page older than this cursor (from a previous call's oldestSeq). Omit for the most recent page."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max messages to return (default 20, max 50)."),
    },
    async (args) => {
      const id = randomUUID();
      try {
        const result = await withTimeout(
          readHistory(id, {
            to: args.to,
            ...(args.threadRootId !== undefined ? { threadRootId: args.threadRootId } : {}),
            ...(args.beforeSeq !== undefined ? { beforeSeq: args.beforeSeq } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          }),
          SEND_TIMEOUT_MS,
        );
        if (result.ok) {
          const body = result.text?.trim().length ? result.text : "(no messages)";
          const cursorNote = result.oldestSeq
            ? `\n\n(to page further back, call again with beforeSeq:"${result.oldestSeq}")`
            : "\n\n(no earlier messages)";
          return { content: [{ type: "text", text: `${body}${cursorNote}` }] };
        }
        return {
          content: [{ type: "text", text: `Failed to read history: ${result.error ?? "unknown error"}` }],
          isError: true,
        };
      } catch (err) {
        log.error("read_history tool failed", { err: String(err) });
        return {
          content: [
            {
              type: "text",
              text: `Failed to read history for ${args.to}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  const scheduleCreateTool = tool(
    "schedule_create",
    "Schedule a future turn for yourself: recurring (cron + IANA timezone) or one-time (runAt). " +
      "CRITICAL: the prompt runs later, for a future you with NO memory of this conversation — " +
      "make it fully self-contained (the task, where to post results, any channel names/repos/" +
      "links/criteria it needs). Don't write \"do the thing we discussed\"; write the thing. " +
      "Limits: 10 schedules per agent, recurring at most every 15 minutes.",
    {
      prompt: z
        .string()
        .max(4000)
        .describe(
          "The standing instruction, written for a future you with no memory of this chat. " +
            "Self-contained and specific.",
        ),
      cron: z
        .string()
        .optional()
        .describe(
          'Recurring cadence as a 5-field cron expression, e.g. "0 9 * * 1-5" (9am weekdays). ' +
            "Provide cron+timezone OR runAt, not both.",
        ),
      timezone: z
        .string()
        .optional()
        .describe('IANA timezone the cron is evaluated in, e.g. "America/Los_Angeles". Required with cron.'),
      runAt: z
        .string()
        .optional()
        .describe('One-time: ISO-8601 timestamp to run once, e.g. "2026-07-06T17:00:00Z". Must be in the future.'),
      channel: z
        .string()
        .optional()
        .describe(
          'Context channel like "#general" for the schedule\'s confirmations and notices. ' +
            "Defaults to the channel this turn came from.",
        ),
    },
    async (args) => {
      const id = randomUUID();
      try {
        const result = await withTimeout(
          bridges.scheduleCreate(id, {
            prompt: args.prompt,
            ...(args.cron !== undefined ? { cron: args.cron } : {}),
            ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
            ...(args.runAt !== undefined ? { runAt: args.runAt } : {}),
            ...(args.channel !== undefined ? { channel: args.channel } : {}),
          }),
          SEND_TIMEOUT_MS,
        );
        if (result.ok) {
          const when = result.nextRunAt ? ` Next run: ${result.nextRunAt}.` : "";
          return { content: [{ type: "text", text: `Scheduled (id ${result.scheduleId}).${when}` }] };
        }
        return {
          content: [{ type: "text", text: `Failed to create schedule: ${result.error ?? "unknown error"}` }],
          isError: true,
        };
      } catch (err) {
        log.error("schedule_create tool failed", { err: String(err) });
        return {
          content: [
            { type: "text", text: `Failed to create schedule: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    },
  );

  const scheduleListTool = tool(
    "schedule_list",
    "List your existing schedules (id, cadence, next run, last result, prompt). Read-only. Use " +
      "before creating near-duplicates and to find the id for schedule_cancel.",
    {},
    async () => {
      const id = randomUUID();
      try {
        const result = await withTimeout(bridges.scheduleList(id), SEND_TIMEOUT_MS);
        if (result.ok) {
          return { content: [{ type: "text", text: result.text?.trim().length ? result.text : "You have no schedules." }] };
        }
        return {
          content: [{ type: "text", text: `Failed to list schedules: ${result.error ?? "unknown error"}` }],
          isError: true,
        };
      } catch (err) {
        log.error("schedule_list tool failed", { err: String(err) });
        return {
          content: [
            { type: "text", text: `Failed to list schedules: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    },
  );

  const scheduleCancelTool = tool(
    "schedule_cancel",
    "Cancel (permanently delete) one of your schedules by id (from schedule_list or " +
      "schedule_create). Use when the standing task is done or no longer makes sense.",
    {
      scheduleId: z.string().describe("The schedule's id"),
    },
    async (args) => {
      const id = randomUUID();
      try {
        const result = await withTimeout(
          bridges.scheduleCancel(id, { scheduleId: args.scheduleId }),
          SEND_TIMEOUT_MS,
        );
        if (result.ok) return { content: [{ type: "text", text: "Schedule cancelled." }] };
        return {
          content: [{ type: "text", text: `Failed to cancel schedule: ${result.error ?? "unknown error"}` }],
          isError: true,
        };
      } catch (err) {
        log.error("schedule_cancel tool failed", { err: String(err) });
        return {
          content: [
            { type: "text", text: `Failed to cancel schedule: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    },
  );

  return createSdkMcpServer({
    name: "jungle",
    version: "1.0.0",
    tools: [sendMessage, readHistoryTool, scheduleCreateTool, scheduleListTool, scheduleCancelTool],
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for backend")), ms);
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
