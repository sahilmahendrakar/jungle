// The `send_message` custom tool: the agent's only way to speak to users.
// Registered as an in-process SDK MCP server (name "jungle"), auto-allowed via
// allowedTools: ["mcp__jungle__send_message"]. The handler forwards a
// `send_message` frame to the backend and awaits the matching `send_message_result`.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";

export interface SendMessageResult {
  ok: boolean;
  error?: string;
  messageId?: string;
}

// Injected by the runner: forwards the frame and returns a promise resolved when
// the backend replies with send_message_result (or rejected/timed out).
export type SendMessageBridge = (
  id: string,
  input: { to: string; body: string },
) => Promise<SendMessageResult>;

const SEND_TIMEOUT_MS = 60_000;

export function createJungleMcpServer(bridge: SendMessageBridge) {
  const sendMessage = tool(
    "send_message",
    "Send a chat message to a Jungle channel or user. This is the ONLY way to " +
      "communicate with people; plain assistant text is never shown to users. " +
      "`to` is a channel like \"#general\" or a handle like \"@alice\".",
    {
      to: z.string().describe('Destination: "#channel" or "@handle"'),
      body: z.string().describe("The message text to post"),
    },
    async (args) => {
      const id = randomUUID();
      try {
        const result = await withTimeout(
          bridge(id, { to: args.to, body: args.body }),
          SEND_TIMEOUT_MS,
        );
        if (result.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Message sent to ${args.to}${
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
