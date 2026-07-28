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
  // Set when this is a "Reconnect" on one specific existing connection — the callback updates
  // that row in place. Absent for a fresh "Connect" / "add another account", which always
  // creates a new row (see the callback below).
  connectionId: string | null;
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

// Begin a connect flow for an already-resolved participant. Used by the route below AND by the
// Liana web API (routes/liana.ts), whose users authenticate with a Liana token instead of a
// Firebase session. The adapter builds the authorize URL + per-attempt state; we bind it to a
// fresh OAuth `state` and return the URL for the caller to navigate/popup to.
//
// `connectionId` set = "Reconnect" on one specific existing connection (verified to belong to
// `me`/`key`); omitted = a fresh "Connect" / "add another account", which always creates a new
// row on callback rather than overwriting anything.
export async function beginIntegrationConnect(
  me: db.Participant,
  key: string,
  popup: boolean,
  connectionId?: string | null,
): Promise<string> {
  const adapter = connectionAdapter(key);
  if (connectionId) {
    const existing = await db.getIntegrationConnectionById(connectionId);
    if (!existing || existing.participant_id !== me.id || existing.integration_key !== key) {
      throw new ApiError(404, "connection not found");
    }
  }
  const state = randomBytes(16).toString("hex");
  const start = await adapter.connection!.start({ me, redirectUri: REDIRECT_URI });
  trackConnect(state, { participantId: me.id, key, pending: start.pending, popup, connectionId: connectionId ?? null });
  // The adapter returns an authorize URL without `state` (it can't know ours); append it.
  const url = new URL(start.authorizeUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

// Step 1: Settings → Connections hits this to begin connecting.
router.post(
  "/api/integrations/:key/connect-url",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const connectionId = typeof req.body?.connectionId === "string" ? req.body.connectionId : null;
    const url = await beginIntegrationConnect(me, String(req.params.key), req.body?.popup === true, connectionId);
    res.json({ url });
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
    if (entry.connectionId) {
      // Reconnect: revive the one connection this popup targeted, in place.
      await db.updateIntegrationConnectionById(entry.connectionId, {
        externalAccount: result.externalAccount,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        accessExpiresAt: result.accessExpiresAt,
        scopes: result.scopes,
        extra: result.extra,
      });
    } else {
      // Fresh connect / "add another account": always a new row.
      await db.createIntegrationConnection({
        participantId: me.id,
        key: entry.key,
        externalAccount: result.externalAccount,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        accessExpiresAt: result.accessExpiresAt,
        scopes: result.scopes,
        extra: result.extra,
      });
    }
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
// agent integration cards read this). `{ [key]: { connected, externalAccount, needsReconnect } }`
// — needsReconnect means the stored grant is dead (invalid_grant) and the user must re-consent.
// Single-row-per-key shape, kept for existing callers (liana-web, the main app's legacy card);
// when a user holds several connections for a key, this reports the most recently updated one —
// see GET /api/integrations/connections for the full multi-account list.
router.get(
  "/api/integrations/status",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const rows = await db.listIntegrationConnections(me.id); // newest-updated first
    const byKey = new Map<string, db.IntegrationConnectionRow>();
    for (const row of rows) if (!byKey.has(row.integration_key)) byKey.set(row.integration_key, row);
    const status: Record<
      string,
      { connected: boolean; externalAccount?: string | null; needsReconnect?: boolean }
    > = {};
    for (const key of CONNECTION_KEYS) {
      const row = byKey.get(key);
      status[key] = row
        ? { connected: true, externalAccount: row.external_account, needsReconnect: row.needs_reconnect }
        : { connected: false };
    }
    res.json(status);
  }),
);

// The authed user's FULL connection list for every connection-based integration, keyed by
// integration key — the multi-account read model (Settings' "add another account" list, and the
// agent create/edit account picker). Unlike /status, this doesn't collapse multiple connections
// for the same key into one.
router.get(
  "/api/integrations/connections",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const rows = await db.listIntegrationConnections(me.id); // newest-updated first
    const byKey: Record<
      string,
      Array<{ id: string; externalAccount: string | null; needsReconnect: boolean; updatedAt: string }>
    > = {};
    for (const key of CONNECTION_KEYS) byKey[key] = [];
    for (const row of rows) {
      if (!(row.integration_key in byKey)) continue;
      byKey[row.integration_key].push({
        id: row.id,
        externalAccount: row.external_account,
        needsReconnect: row.needs_reconnect,
        updatedAt: row.updated_at,
      });
    }
    res.json(byKey);
  }),
);

// Disconnect: drop the authed user's grant for one integration (ALL connections under that key —
// the single-slot flow other callers use). Agents whose integration was backed by any of them stop
// getting a token at their next configure. For one specific account, see the id-based route below.
router.delete(
  "/api/integrations/:key/connection",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    await db.deleteIntegrationConnection(me.id, String(req.params.key));
    res.json({ ok: true });
  }),
);

// Disconnect one specific connection by id (the multi-account "Disconnect" button in Settings).
router.delete(
  "/api/integrations/connections/:id",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const conn = await db.getIntegrationConnectionById(String(req.params.id));
    if (conn && conn.participant_id === me.id) await db.deleteIntegrationConnectionById(conn.id);
    res.json({ ok: true });
  }),
);

export default router;
