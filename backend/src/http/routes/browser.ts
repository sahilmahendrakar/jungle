import { Router } from "express";
import { BROWSER_SITES, browserSite, type BrowserSigninView } from "@jungle/shared";
import * as db from "../../db";
import { wrap, ApiError } from "../errors";
import { requireRequester } from "../guards";
import { isBrowserConfigured, liveViewFor, startSignin } from "../../services/browser";

// The browser integration's HTTP surface: the human half of "an agent needs you to log in".
//
// The load-bearing route here is GET /signin/:id/view. Browserbase's live-view URL is a BEARER
// CAPABILITY — anyone holding it drives a browser that is about to hold a real logged-in session.
// Jungle messages are persisted, ⌘K-searchable and mirrored into Slack, so that URL must never be
// put in one. Instead the agent shares /browser-signin/<id> and this route mints the capability
// per-view, only for the participant who actually has to sign in, and only while the request is
// still open. Nothing durable ever stores it.

const router = Router();

// The user's connected browser profiles (Settings → Connections). `needsReconnect` is the state
// that matters: the row survives when a site invalidates the session, and an agent that doesn't
// know it's logged out is an agent that hallucinates instead of asking.
router.get(
  "/api/browser/profiles",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const rows = await db.listIntegrationConnectionsForKey(me.id, "browser");
    res.json({
      configured: isBrowserConfigured(),
      sites: BROWSER_SITES.map((s) => ({ key: s.key, label: s.label })),
      profiles: rows.map((r) => {
        const extra = r.extra as { site?: string; lastVerifiedAt?: string };
        const site = browserSite(extra.site ?? "");
        return {
          connectionId: r.id,
          site: extra.site ?? "",
          siteLabel: site?.label ?? r.external_account ?? extra.site ?? "",
          needsReconnect: r.needs_reconnect,
          lastVerifiedAt: extra.lastVerifiedAt ?? null,
        };
      }),
    });
  }),
);

// Start a sign-in the user initiated themselves (Settings → Connections → Browser → Add a site).
// The agent-initiated path goes through the browser_signin tool instead, but lands in the same
// place: one request row, one live view, one watcher.
router.post(
  "/api/browser/signin",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    if (!isBrowserConfigured()) throw new ApiError(503, "The browser integration is not configured on this server");
    const site = String(req.body?.site ?? "").trim();
    if (!browserSite(site)) throw new ApiError(400, `Unknown site "${site}"`);
    const r = await startSignin(me, null, site);
    res.json(r);
  }),
);

// Status of one sign-in, for the page to render and poll. Deliberately carries no live-view URL —
// that comes from /view below, which is a separate call precisely so the capability isn't handed
// out as a side effect of a status check.
router.get(
  "/api/browser/signin/:id",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const row = await db.getBrowserSigninRequest(String(req.params.id));
    // Same 404 whether the request is missing or belongs to someone else: a different answer for
    // "exists but not yours" would confirm ids to anyone who guesses one.
    if (!row || row.participant_id !== me.id) throw new ApiError(404, "sign-in request not found");
    const site = browserSite(row.site);
    res.json({
      id: row.id,
      site: row.site,
      siteLabel: site?.label ?? row.site,
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    });
  }),
);

// Mint the live view. The ONLY place the Browserbase capability URL is produced, and it is scoped
// three ways: the caller must be the participant who has to sign in, the request must still be
// pending, and it must not have expired (all enforced in liveViewFor).
router.get(
  "/api/browser/signin/:id/view",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const view = await liveViewFor(String(req.params.id), me.id);
    if (!view) throw new ApiError(404, "sign-in request is not open");
    // Belt and braces: keep this out of any shared cache, since the body is a live capability.
    res.setHeader("Cache-Control", "no-store");
    // Annotated with the shared wire type on purpose: res.json() accepts anything, so without this
    // a renamed field silently reaches the client as undefined (which is exactly how the sign-in
    // page ended up stuck on "Connecting…").
    const body: BrowserSigninView = { requestId: String(req.params.id), ...view };
    res.json(body);
  }),
);

// Disconnect a profile. Deleting the row is enough to cut every agent off it — grants resolve from
// the owner's live connections on each turn, so nothing keeps working off a stale config.
router.delete(
  "/api/browser/profiles/:connectionId",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const row = await db.getIntegrationConnectionById(String(req.params.connectionId));
    if (!row || row.participant_id !== me.id || row.integration_key !== "browser") {
      throw new ApiError(404, "profile not found");
    }
    await db.deleteIntegrationConnectionById(row.id);
    res.json({ ok: true });
  }),
);

export default router;
