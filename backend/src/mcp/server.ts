import { Router, type Request, type Response } from "express";
import * as db from "../db";
import { requester } from "../http/guards";
import { JUNGLE_TOOLS } from "./tools";
import { ApiError } from "../http/errors";

// The inbound Jungle MCP server: POST /mcp speaks MCP's Streamable HTTP transport in its
// stateless form — every JSON-RPC request is answered with a plain application/json response
// (the spec's allowed alternative to an SSE stream), no session state, no server-initiated
// messages. That's all tools/list + tools/call need, and it keeps the endpoint dependency-free.
//
// Auth is the same seam as the REST routes: guards.requester(), so an API token ("jgl_…",
// db/apiTokens.ts) resolves to the participant the tools act as. External agents point their MCP
// client here with `Authorization: Bearer jgl_…`; in-Jungle agents get it mounted automatically
// by the jungle integration (integrations/jungle.ts) via the runner's mcpIntegrations plumbing.

const SERVER_INFO = { name: "jungle", version: "1.0.0" };
// Versions whose initialize/tools exchanges are shape-compatible with this implementation.
const KNOWN_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

const toolsByName = new Map(JUNGLE_TOOLS.map((t) => [t.name, t]));

async function handleMessage(actor: db.Participant, msg: JsonRpcMessage): Promise<object | null> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id ?? null, -32600, "invalid request");
  }
  // Notifications (no id) get no response; nothing here needs to act on them.
  if (msg.id === undefined || msg.id === null) return null;

  switch (msg.method) {
    case "initialize": {
      const requested = String(msg.params?.protocolVersion ?? "");
      return rpcResult(msg.id, {
        protocolVersion: KNOWN_PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          `You are connected to the Jungle workspace as @${actor.handle} (${actor.kind}). ` +
          "Tools act with that identity: messages post under this handle, and everything is " +
          "scoped to its workspace.",
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, {
        tools: JUNGLE_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.readOnly ? { annotations: { readOnlyHint: true } } : {}),
        })),
      });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = toolsByName.get(name);
      if (!tool) return rpcError(msg.id, -32602, `unknown tool: ${name}`);
      const args =
        msg.params?.arguments && typeof msg.params.arguments === "object"
          ? (msg.params.arguments as Record<string, unknown>)
          : {};
      try {
        const text = await tool.handler(actor, args);
        return rpcResult(msg.id, { content: [{ type: "text", text }] });
      } catch (e) {
        // Tool failures are RESULTS with isError (the model should see them), not protocol errors.
        const text = e instanceof ApiError ? e.message : String((e as Error).message ?? e);
        if (!(e instanceof ApiError)) console.error(`mcp tool ${name} failed:`, e);
        return rpcResult(msg.id, { content: [{ type: "text", text: `Error: ${text}` }], isError: true });
      }
    }
    default:
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

const router = Router();

router.post("/mcp", async (req: Request, res: Response) => {
  const actor = await requester(req);
  if (!actor) {
    res.status(401).json({ error: "authenticate with an API token: Authorization: Bearer jgl_…" });
    return;
  }
  const body = req.body as JsonRpcMessage | JsonRpcMessage[] | undefined;
  const messages = Array.isArray(body) ? body : [body as JsonRpcMessage];
  if (!messages.length || body === undefined) {
    res.status(400).json(rpcError(null, -32700, "empty request"));
    return;
  }
  const responses = (await Promise.all(messages.map((m) => handleMessage(actor, m)))).filter(
    (r): r is object => r !== null,
  );
  // All notifications -> nothing to say; 202 per the Streamable HTTP spec.
  if (!responses.length) {
    res.status(202).end();
    return;
  }
  res.json(Array.isArray(body) ? responses : responses[0]);
});

// No server-initiated streams and no sessions to terminate — both are optional in the spec.
router.get("/mcp", (_req, res) => void res.status(405).json({ error: "method not allowed" }));
router.delete("/mcp", (_req, res) => void res.status(405).json({ error: "method not allowed" }));

export default router;
