// The `send_message` custom tool: the agent's only way to speak to users.
// Registered as an in-process SDK MCP server (name "jungle"), auto-allowed via
// allowedTools: ["mcp__jungle__send_message"]. The handler uploads any `files` (workspace
// paths) to the backend first, then forwards a `send_message` frame referencing the upload
// ids and awaits the matching `send_message_result`.
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

// Injected by the runner: uploads one workspace file to the backend, returning its
// attachment id. Throws with a human-readable message on failure.
export type FileUploader = (filePath: string) => Promise<UploadedAttachment>;

const SEND_TIMEOUT_MS = 60_000;

export function createJungleMcpServer(bridge: SendMessageBridge, uploadFile: FileUploader) {
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

  return createSdkMcpServer({
    name: "jungle",
    version: "1.0.0",
    tools: [sendMessage],
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
