import { Router } from "express";
import { Readable } from "node:stream";
import * as db from "../../db";

// Inference proxy for self-hosted runners. A runner child on a user's machine points its Agent SDK
// at ANTHROPIC_BASE_URL=<backend>/api/llm with ANTHROPIC_API_KEY=<its own runner_token>, so the
// platform's real Anthropic key NEVER leaves the backend (the user handles no key at all). Here we
// authenticate the runner token, swap in the real key, forward to Anthropic, and stream the
// response straight back (SSE for streaming turns).
//
// This router is mounted BEFORE express.json() (see app.ts) so the request body passes through
// unparsed — we buffer the raw bytes and forward them verbatim.

const router = Router();

const ANTHROPIC_API = (process.env.ANTHROPIC_API_BASE ?? "https://api.anthropic.com").replace(/\/$/, "");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

// Response headers we must NOT copy verbatim: fetch already decoded the body, so length/encoding
// would be wrong, and connection framing is hop-by-hop.
const SKIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

// Express 5 (path-to-regexp v8) requires named wildcards — `*splat` matches the whole /v1/... tail.
router.all("/api/llm/*splat", (req, res) => {
  void (async () => {
    // Authenticate by runner token (x-api-key is what the Anthropic SDK sends as the "key").
    const token = (
      req.header("x-api-key") ||
      req.header("authorization")?.replace(/^Bearer\s+/i, "") ||
      ""
    ).trim();
    const agent = await db.agentByRunnerToken(token);
    if (!agent) {
      res.status(401).json({ type: "error", error: { type: "authentication_error", message: "invalid runner token" } });
      return;
    }
    // Only self-hosted agents route through the proxy; cloud runners get the real key directly.
    if (agent.runner_provider !== "self_hosted") {
      res.status(403).json({ type: "error", error: { type: "permission_error", message: "not permitted" } });
      return;
    }

    // Buffer the raw request body (Anthropic requests are small JSON; only responses need streaming).
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    // Rebuild the upstream URL: strip our /api/llm prefix, keep the /v1/... path + query.
    const upstreamPath = req.originalUrl.replace(/^\/api\/llm/, "");
    const headers: Record<string, string> = {
      "x-api-key": ANTHROPIC_API_KEY,
      "content-type": req.header("content-type") ?? "application/json",
    };
    // Pass through the Anthropic protocol headers the SDK sets; drop any inbound auth headers.
    for (const h of ["anthropic-version", "anthropic-beta", "accept"]) {
      const v = req.header(h);
      if (v) headers[h] = v;
    }

    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(`${ANTHROPIC_API}${upstreamPath}`, {
        method: req.method,
        headers,
        body,
      });
    } catch (e) {
      console.error("llm proxy: upstream unreachable:", e);
      res.status(502).json({ type: "error", error: { type: "api_error", message: "upstream unreachable" } });
      return;
    }

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
    });
    if (!upstream.body) {
      res.end();
      return;
    }
    // Stream the (possibly SSE) body through as it arrives.
    Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  })().catch((e) => {
    console.error("llm proxy:", e);
    if (!res.headersSent) res.status(500).json({ type: "error", error: { type: "api_error", message: "proxy error" } });
  });
});

export default router;
