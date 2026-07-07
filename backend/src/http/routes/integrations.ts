import { Router } from "express";
import { randomBytes } from "node:crypto";
import { INTEGRATION_TYPES, getIntegrationType } from "@jungle/shared";
import * as db from "../../db";
import { wrap, ApiError } from "../errors";
import { requireRequester } from "../guards";
import { adapterFor } from "../../integrations";
import { popupClosePage } from "../oauthPopup";

// Per-USER OAuth connections for the connection-based integrations (Linear/Notion/Granola via their
// remote MCP servers, Google Drive). You connect your accounts once in Settings → Connections, like
// GitHub and Gmail; agents then attach the integration and act with your connection. The per-service
// work lives in each adapter's `connection` (backend/src/integrations/).

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

// The connection-based integration keys (catalog entries marked connection: "oauth").
const CONNECTION_KEYS = INTEGRATION_TYPES.filter((t) => t.connection === "oauth" && !t.comingSoon).map((t) => t.key);

// Pending OAuth round-trips, keyed by the opaque `state`. Holds which user + integration and the
// adapter's per-attempt `pending` (PKCE verifier, token endpoint, …). In-memory is fine for a
// single backend (mirrors routes/google.ts).
interface PendingConnect {
  participantId: string;
  key: string;
  pending: Record<string, unknown>;
  // Flow runs in a popup window — the callback returns a self-closing page (http/oauthPopup.ts)
  // instead of redirecting the whole window to /settings.
  popup: boolean;
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

// Step 1: Settings → Connections hits this to begin connecting. The adapter builds the authorize
// URL and its per-attempt state; we bind it to a fresh OAuth `state` and hand the URL back for the
// SPA to navigate to (full-page redirect).
router.post(
  "/api/integrations/:key/connect-url",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const key = String(req.params.key);
    const adapter = connectionAdapter(key);
    const state = randomBytes(16).toString("hex");
    const start = await adapter.connection!.start({ me, redirectUri: REDIRECT_URI });
    trackConnect(state, { participantId: me.id, key, pending: start.pending, popup: req.body?.popup === true });
    // The adapter returns an authorize URL without `state` (it can't know ours); append it.
    const url = new URL(start.authorizeUrl);
    url.searchParams.set("state", state);
    res.json({ url: url.toString() });
  }),
);

// Step 2: the provider redirects here with ?code & ?state. Resolve the pending attempt, let the
// adapter exchange the code, and persist the per-user grant. No auth middleware — the opaque
// `state` authenticates the round-trip (same model as routes/google.ts).
router.get("/auth/integrations/callback", async (req, res) => {
  const code = (req.query.code as string | undefined) || "";
  const state = (req.query.state as string | undefined) || "";
  const entry = state ? pendingConnects.get(state) : undefined;
  const backToSettings = (params: Record<string, string>) =>
    `${FRONTEND_URL}/settings?${new URLSearchParams(params).toString()}`;
  try {
    if (!code || !entry) return res.status(400).send("invalid or expired OAuth state");
    pendingConnects.delete(state);
    const me = await db.getParticipant(entry.participantId);
    if (!me) return res.status(400).send("connecting user is gone");
    const adapter = connectionAdapter(entry.key);
    const result = await adapter.connection!.complete(
      { me, redirectUri: REDIRECT_URI },
      entry.pending,
      code,
    );
    await db.upsertIntegrationConnection({
      participantId: me.id,
      key: entry.key,
      externalAccount: result.externalAccount,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      accessExpiresAt: result.accessExpiresAt,
      scopes: result.scopes,
      extra: result.extra,
    });
    if (entry.popup) {
      return res.send(
        popupClosePage({ connection: entry.key, status: "connected", account: result.externalAccount ?? undefined }),
      );
    }
    res.redirect(backToSettings({ integration: entry.key, status: "connected" }));
  } catch (e) {
    const reason = String((e as Error).message ?? e);
    if (entry?.popup) return res.send(popupClosePage({ connection: entry.key, status: "error", reason }));
    res.redirect(backToSettings({ integration: entry?.key ?? "", status: "error", reason }));
  }
});

// The authed user's connection status for every connection-based integration (Settings + the
// agent integration cards read this). `{ [key]: { connected, externalAccount } }`.
router.get(
  "/api/integrations/status",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const rows = await db.listIntegrationConnections(me.id);
    const byKey = new Map(rows.map((r) => [r.integration_key, r]));
    const status: Record<string, { connected: boolean; externalAccount?: string | null }> = {};
    for (const key of CONNECTION_KEYS) {
      const row = byKey.get(key);
      status[key] = row ? { connected: true, externalAccount: row.external_account } : { connected: false };
    }
    res.json(status);
  }),
);

// Disconnect: drop the authed user's grant for one integration. Agents whose integration was backed
// by this connection stop getting a token at their next configure.
router.delete(
  "/api/integrations/:key/connection",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    await db.deleteIntegrationConnection(me.id, String(req.params.key));
    res.json({ ok: true });
  }),
);

export default router;
