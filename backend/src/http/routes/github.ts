import { Router } from "express";
import { randomBytes } from "node:crypto";
import * as db from "../../db";
import * as gh from "../../github";
import * as auth from "../../auth";
import { wrap, ApiError } from "../errors";
import { requireRequester } from "../guards";

const router = Router();

// Where the SPA is served — GitHub OAuth callback redirects back here after connecting.
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

// Pending OAuth round-trips: state -> participantId. In-memory is fine for a single backend.
const pendingOAuth = new Map<string, { participantId: string; createdAt: number }>();
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000; // a round-trip that hasn't completed in 15 min is dead

// Record a pending OAuth state, evicting any that have expired (bounds the map — an abandoned
// authorize that never hits the callback would otherwise linger forever).
function trackOAuthState(state: string, participantId: string): void {
  const cutoff = Date.now() - OAUTH_STATE_TTL_MS;
  for (const [k, v] of pendingOAuth) if (v.createdAt < cutoff) pendingOAuth.delete(k);
  pendingOAuth.set(state, { participantId, createdAt: Date.now() });
}

// Step 1 of connect: a human hits this (e.g. a "Connect GitHub" button) and is redirected to
// GitHub to authorize. ?participantId identifies who is connecting (dev path).
router.get("/auth/github", (req, res) => {
  if (!gh.isConfigured()) return res.status(500).send("GitHub App not configured");
  const participantId = (req.query.participantId as string | undefined) || "";
  if (!participantId) return res.status(400).send("participantId required");
  const state = randomBytes(16).toString("hex");
  trackOAuthState(state, participantId);
  res.redirect(gh.authorizeUrl(state));
});

// Auth'd variant for the onboarding flow: the server binds the OAuth `state` to the verified
// user's participant (not a client-supplied id), then the SPA navigates to the returned URL.
router.post(
  "/api/github/connect-url",
  auth.requireAuth,
  wrap(async (req, res) => {
    if (!gh.isConfigured()) return res.status(500).json({ error: "GitHub App not configured" });
    const u = auth.authedUser(req)!;
    const p = await db.getParticipantByFirebaseUid(u.uid);
    if (!p) return res.status(409).json({ error: "finish onboarding first" });
    const state = randomBytes(16).toString("hex");
    trackOAuthState(state, p.id);
    res.json({ url: gh.authorizeUrl(state) });
  }),
);

// Step 2: GitHub redirects back here with ?code & ?state. Exchange + store the identity.
router.get("/auth/github/callback", async (req, res) => {
  try {
    const code = (req.query.code as string | undefined) || "";
    const state = (req.query.state as string | undefined) || "";
    const pending = pendingOAuth.get(state);
    if (!code || !pending) return res.status(400).send("invalid or expired OAuth state");
    pendingOAuth.delete(state);
    const { login } = await gh.exchangeCodeAndStore(pending.participantId, code);
    // Back to the SPA, which reads ?github=connected to advance/refresh the onboarding step.
    res.redirect(`${FRONTEND_URL}/settings?github=connected&login=${encodeURIComponent(login)}`);
  } catch (e) {
    res.redirect(`${FRONTEND_URL}/settings?github=error&reason=${encodeURIComponent(String((e as Error).message ?? e))}`);
  }
});

// GitHub connection + App installation status for the settings page.
router.get(
  "/api/github/status",
  auth.requireAuth,
  wrap(async (req, res) => {
    const u = auth.authedUser(req)!;
    const p = await db.getParticipantByFirebaseUid(u.uid);
    if (!p) return res.status(409).json({ error: "finish onboarding first" });
    res.json(await gh.githubStatus(p.id));
  }),
);

// List the authed user's GitHub repos (via their connected token) for the repo picker. 409 (not
// 500) when GitHub isn't connected, so the UI can fall back to manual entry.
router.get(
  "/api/github/repos",
  auth.requireAuth,
  wrap(async (req, res) => {
    const u = auth.authedUser(req)!;
    const p = await db.getParticipantByFirebaseUid(u.uid);
    if (!p) return res.status(409).json({ connected: false, error: "finish onboarding first" });
    if (!(await db.getGithubIdentity(p.id))) {
      return res.status(409).json({ connected: false, error: "github not connected" });
    }
    res.json({ connected: true, repos: await gh.listUserRepos(p.id) });
  }),
);

// Disconnect the authed user's GitHub account (removes the stored identity/tokens).
router.delete(
  "/api/github/connection",
  auth.requireAuth,
  wrap(async (req, res) => {
    const u = auth.authedUser(req)!;
    const p = await db.getParticipantByFirebaseUid(u.uid);
    if (!p) return res.status(409).json({ error: "finish onboarding first" });
    await db.deleteGithubIdentity(p.id);
    res.json({ ok: true });
  }),
);

// Open a PR using a participant's connected token. The requester may only open a PR as
// themselves — participantId must match the authenticated requester (previously this trusted a
// client-supplied participantId, letting anyone open a PR with anyone's linked GitHub token).
router.post(
  "/api/github/open-pr",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const { participantId, repo, title, body, files, headBranch, baseBranch } = req.body ?? {};
    if (!participantId || !repo || !title || !files) {
      return res.status(400).json({ error: "participantId, repo, title, files required" });
    }
    if (participantId !== me.id) throw new ApiError(403, "cannot open a PR as another participant");
    res.status(201).json(
      await gh.openPullRequest({ participantId, repo, title, body, files, headBranch, baseBranch }),
    );
  }),
);

// Open a PR as the GitHub App bot (installation token). Verifies the bot-identity path
// independent of the agent loop.
router.post(
  "/api/github/bot-open-pr",
  wrap(async (req, res) => {
    if (!gh.appAuthConfigured()) {
      return res.status(500).json({ error: "GitHub App private key not configured" });
    }
    const { repo, title, body, files, headBranch, baseBranch } = req.body ?? {};
    if (!repo || !title || !files) {
      return res.status(400).json({ error: "repo, title, files required" });
    }
    res.status(201).json(await gh.openPrAsBot({ repo, title, body, files, headBranch, baseBranch }));
  }),
);

export default router;
