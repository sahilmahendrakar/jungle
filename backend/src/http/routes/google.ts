import { Router } from "express";
import { randomBytes } from "node:crypto";
import * as db from "../../db";
import * as google from "../../google";
import * as auth from "../../auth";
import { wrap } from "../errors";
import { popupClosePage } from "../oauthPopup";

const router = Router();

// Where the SPA is served — the OAuth callback redirects back here after connecting.
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

// Pending OAuth round-trips: state -> participantId. In-memory is fine for a single backend
// (mirrors http/routes/github.ts).
// `popup` marks flows run in a popup window — the callback then returns a self-closing page
// (http/oauthPopup.ts) instead of redirecting the whole window to /settings.
const pendingOAuth = new Map<string, { participantId: string; popup: boolean; createdAt: number }>();
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000; // a round-trip that hasn't completed in 15 min is dead

function trackOAuthState(state: string, participantId: string, popup = false): void {
  const cutoff = Date.now() - OAUTH_STATE_TTL_MS;
  for (const [k, v] of pendingOAuth) if (v.createdAt < cutoff) pendingOAuth.delete(k);
  pendingOAuth.set(state, { participantId, popup, createdAt: Date.now() });
}

// Begin a connect flow for an already-resolved participant. Used by this router's SPA endpoint
// below AND by the Liana web API (routes/liana.ts), whose users authenticate with a Liana token
// instead of a Firebase session. Returns null when Google OAuth isn't configured.
export function beginGoogleConnect(participantId: string, popup: boolean): string | null {
  if (!google.isConfigured()) return null;
  const state = randomBytes(16).toString("hex");
  trackOAuthState(state, participantId, popup);
  return google.authorizeUrl(state);
}

// Step 1 of connect: the SPA (Settings → Connections) hits this; the server binds the OAuth
// `state` to the verified user's participant, then the SPA navigates to the returned URL.
router.post(
  "/api/google/connect-url",
  auth.requireAuth,
  wrap(async (req, res) => {
    if (!google.isConfigured()) return res.status(500).json({ error: "Google OAuth not configured" });
    const u = auth.authedUser(req)!;
    const p = await db.getParticipantByFirebaseUid(u.uid);
    if (!p) return res.status(409).json({ error: "finish onboarding first" });
    const state = randomBytes(16).toString("hex");
    trackOAuthState(state, p.id, req.body?.popup === true);
    console.log(`google oauth: begin connect for participant ${p.id} (popup=${req.body?.popup === true})`);
    res.json({ url: google.authorizeUrl(state) });
  }),
);

// Step 2: Google redirects back here with ?code & ?state. Exchange + store the identity.
// Every exit path logs: a failed (re)connect is otherwise invisible — the popup page closes
// itself, so the only record of *why* it failed is here.
router.get("/auth/google/callback", async (req, res) => {
  const state = (req.query.state as string | undefined) || "";
  const pending = pendingOAuth.get(state);
  const fail = (reason: string, status = 200) => {
    console.error(`google oauth callback failed: ${reason}`);
    if (pending?.popup) return res.send(popupClosePage({ connection: "google", status: "error", reason }));
    if (!pending) return res.status(status).send(reason);
    res.redirect(`${FRONTEND_URL}/settings?google=error&reason=${encodeURIComponent(reason)}`);
  };
  try {
    const code = (req.query.code as string | undefined) || "";
    // Google reports a refused consent by redirecting HERE with ?error (access_denied,
    // admin_policy_enforced, …) and no code — surface its reason instead of blaming our state.
    const denied = (req.query.error as string | undefined) || "";
    if (denied) {
      const detail = (req.query.error_description as string | undefined) || "";
      return fail(`Google refused the authorization: ${denied}${detail ? ` — ${detail}` : ""}`);
    }
    if (!code) return fail("Google returned no authorization code", 400);
    // `pendingOAuth` is in-memory, so a backend restart mid-flow invalidates the round-trip.
    if (!pending) return fail("invalid or expired OAuth state", 400);
    pendingOAuth.delete(state);
    const { email } = await google.exchangeCodeAndStore(pending.participantId, code);
    console.log(`google oauth: connected ${email} for participant ${pending.participantId}`);
    if (pending.popup) {
      return res.send(popupClosePage({ connection: "google", status: "connected", account: email }));
    }
    // Back to the SPA, which reads ?google=connected to refresh the Connections section.
    res.redirect(`${FRONTEND_URL}/settings?google=connected&email=${encodeURIComponent(email)}`);
  } catch (e) {
    fail(String((e as Error).message ?? e));
  }
});

// Google connection status for the settings page.
router.get(
  "/api/google/status",
  auth.requireAuth,
  wrap(async (req, res) => {
    const u = auth.authedUser(req)!;
    const p = await db.getParticipantByFirebaseUid(u.uid);
    if (!p) return res.status(409).json({ error: "finish onboarding first" });
    res.json(await google.googleStatus(p.id));
  }),
);

// Disconnect the authed user's Google account (removes the stored identity/tokens). Agents whose
// Gmail integration was backed by this account will stop getting a token at their next configure.
router.delete(
  "/api/google/connection",
  auth.requireAuth,
  wrap(async (req, res) => {
    const u = auth.authedUser(req)!;
    const p = await db.getParticipantByFirebaseUid(u.uid);
    if (!p) return res.status(409).json({ error: "finish onboarding first" });
    await db.deleteGoogleIdentity(p.id);
    res.json({ ok: true });
  }),
);

export default router;
