import { Router } from "express";
import { randomBytes } from "node:crypto";
import { getIntegrationType } from "@jungle/shared";
import * as db from "../../db";
import { wrap, ApiError } from "../errors";
import { requireAgent } from "../guards";
import { adapterFor } from "../../integrations";

// Generic OAuth connect flow for connection-based integrations (Linear/Notion/Granola via their
// remote MCP servers, Google Drive). One set of routes for all of them: the per-service work lives
// in each adapter's `connection` (backend/src/integrations/). Connections are per-AGENT — a human
// authorizes from the agent's profile and the grant belongs to that agent (integration_connections).

const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

// The backend's public origin, used to build the OAuth callback URL the provider redirects to. In
// prod it's derived from GOOGLE_OAUTH_REDIRECT_URI's origin (already the backend's public host);
// override with BACKEND_PUBLIC_URL. This exact URL must be an authorized redirect URI on any fixed
// OAuth client (Google Drive) and is what we register via DCR for remote MCP providers.
const BACKEND_ORIGIN = (() => {
  if (process.env.BACKEND_PUBLIC_URL) return process.env.BACKEND_PUBLIC_URL.replace(/\/$/, "");
  const g = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (g) {
    try {
      return new URL(g).origin;
    } catch {
      /* fall through */
    }
  }
  return "http://localhost:3001";
})();
const REDIRECT_URI = `${BACKEND_ORIGIN}/auth/integrations/callback`;

// Pending OAuth round-trips, keyed by the opaque `state`. Holds everything the callback needs
// (which agent+integration, who authorized it, and the adapter's per-attempt `pending`: PKCE
// verifier, token endpoint, …). In-memory is fine for a single backend (mirrors routes/google.ts).
interface PendingConnect {
  agentId: string;
  meId: string;
  key: string;
  pending: Record<string, unknown>;
  createdAt: number;
}
const pendingConnects = new Map<string, PendingConnect>();
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

function trackConnect(state: string, entry: Omit<PendingConnect, "createdAt">): void {
  const cutoff = Date.now() - OAUTH_STATE_TTL_MS;
  for (const [k, v] of pendingConnects) if (v.createdAt < cutoff) pendingConnects.delete(k);
  pendingConnects.set(state, { ...entry, createdAt: Date.now() });
}

// Guard: the integration key must be a known, wired (not comingSoon) connection-based integration.
function connectionAdapter(key: string) {
  const type = getIntegrationType(key);
  if (!type || type.comingSoon) throw new ApiError(400, `unsupported integration: ${key}`);
  const adapter = adapterFor(key);
  if (!adapter?.connection) throw new ApiError(400, `integration ${key} is not connection-based`);
  return adapter;
}

// Step 1: the agent-profile UI hits this to begin connecting. The adapter builds the authorize URL
// and its per-attempt state; we bind it to a fresh OAuth `state` and hand the URL back for the SPA
// to navigate to (full-page redirect).
router.post(
  "/api/agents/:id/integrations/:key/connect-url",
  wrap(async (req, res) => {
    const { me, agent } = await requireAgent(req);
    const key = String(req.params.key);
    const adapter = connectionAdapter(key);
    const state = randomBytes(16).toString("hex");
    const start = await adapter.connection!.start({ agentId: agent.id, me, redirectUri: REDIRECT_URI });
    trackConnect(state, { agentId: agent.id, meId: me.id, key, pending: start.pending });
    // The adapter returns an authorize URL without `state` (it can't know ours); append it. If the
    // adapter already set a state param, ours wins (last value) — providers read the last.
    const url = new URL(start.authorizeUrl);
    url.searchParams.set("state", state);
    res.json({ url: url.toString() });
  }),
);

// Step 2: the provider redirects here with ?code & ?state. Resolve the pending attempt, let the
// adapter exchange the code, and persist the per-agent grant. No auth middleware — the opaque
// `state` authenticates the round-trip (same model as routes/google.ts).
router.get("/auth/integrations/callback", async (req, res) => {
  const code = (req.query.code as string | undefined) || "";
  const state = (req.query.state as string | undefined) || "";
  const entry = state ? pendingConnects.get(state) : undefined;
  const backToApp = (params: Record<string, string>) =>
    `${FRONTEND_URL}/?${new URLSearchParams(params).toString()}`;
  try {
    if (!code || !entry) return res.status(400).send("invalid or expired OAuth state");
    pendingConnects.delete(state);
    const me = await db.getParticipant(entry.meId);
    if (!me) return res.status(400).send("connecting user is gone");
    const adapter = connectionAdapter(entry.key);
    const result = await adapter.connection!.complete(
      { agentId: entry.agentId, me, redirectUri: REDIRECT_URI },
      entry.pending,
      code,
    );
    await db.upsertIntegrationConnection({
      agentId: entry.agentId,
      key: entry.key,
      externalAccount: result.externalAccount,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      accessExpiresAt: result.accessExpiresAt,
      scopes: result.scopes,
      extra: result.extra,
      createdBy: me.id,
    });
    res.redirect(backToApp({ integration: entry.key, agent: entry.agentId, connected: "1" }));
  } catch (e) {
    res.redirect(
      backToApp({
        integration: entry?.key ?? "",
        agent: entry?.agentId ?? "",
        error: String((e as Error).message ?? e),
      }),
    );
  }
});

// Connection status for the agent-profile integrations card.
router.get(
  "/api/agents/:id/integrations/:key/connection",
  wrap(async (req, res) => {
    const { agent } = await requireAgent(req);
    const key = String(req.params.key);
    const row = await db.getIntegrationConnection(agent.id, key);
    res.json(row ? { connected: true, externalAccount: row.external_account } : { connected: false });
  }),
);

// Disconnect: drop the agent's stored grant. Its runner stops getting a token at the next configure.
router.delete(
  "/api/agents/:id/integrations/:key/connection",
  wrap(async (req, res) => {
    const { agent } = await requireAgent(req);
    await db.deleteIntegrationConnection(agent.id, String(req.params.key));
    res.json({ ok: true });
  }),
);

export default router;
