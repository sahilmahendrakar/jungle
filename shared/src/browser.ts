// The browser integration's shared contracts: which sites an agent can hold a logged-in profile
// for, and the shape of a sign-in handshake. Single source of truth for the backend (which drives
// Browserbase) and the frontend (which renders the sign-in card and the live-view page).
//
// The premise: a Browserbase Context persists cookies/localStorage indefinitely, so a human logs
// in ONCE by hand inside a cloud browser and the agent reuses that profile from fresh sessions
// afterwards. Credentials are never stored — Jungle only ever holds a context id.

export type BrowserSiteKey = "linkedin" | "x" | "generic";

export interface BrowserSite {
  key: BrowserSiteKey;
  label: string;
  // Where the sign-in session lands the human.
  loginUrl: string;
  // A page reachable ONLY when authenticated. The whole liveness check is "did we get bounced to
  // a login wall?", so a publicly-viewable URL here would report success for a logged-out profile
  // and silently hand the agent a dead session.
  probeUrl: string;
  // URL fragments whose presence after navigation means we got bounced.
  loggedOutMarkers: string[];
  // A selector that only renders for an authed user — belt-and-braces for the case where the URL
  // looks right but the page is actually a wall.
  loggedInSelector: string;
  // The session cookie whose appearance means "logged in". We detect sign-in completion by
  // POLLING for this rather than by navigating: navigating would yank the page out from under the
  // human and could destroy a half-finished 2FA flow.
  authCookie: string;
  // Domains the agent may navigate to while using this profile. Enforced server-side on every
  // navigate. Keeps a prompt-injected agent from walking a live LinkedIn session over to a
  // password-reset flow or an attacker's collection endpoint.
  allowedDomains: string[];
}

export const BROWSER_SITES: BrowserSite[] = [
  {
    key: "linkedin",
    label: "LinkedIn",
    loginUrl: "https://www.linkedin.com/login",
    probeUrl: "https://www.linkedin.com/feed/",
    loggedOutMarkers: ["/login", "/authwall", "/uas/login", "/checkpoint"],
    loggedInSelector: "main, .scaffold-layout__main, [data-test-id='feed']",
    authCookie: "li_at",
    allowedDomains: ["linkedin.com", "www.linkedin.com", "static.licdn.com", "media.licdn.com"],
  },
  {
    key: "x",
    label: "X (Twitter)",
    loginUrl: "https://x.com/login",
    probeUrl: "https://x.com/home",
    loggedOutMarkers: ["/login", "/i/flow/login", "/i/flow/signup", "?logout"],
    loggedInSelector: "[data-testid='primaryColumn'], [aria-label='Home timeline']",
    authCookie: "auth_token",
    allowedDomains: ["x.com", "twitter.com", "pbs.twimg.com", "abs.twimg.com"],
  },
];

export const browserSite = (key: string): BrowserSite | undefined =>
  BROWSER_SITES.find((s) => s.key === key);

// --- sign-in handshake ---

export type BrowserSigninStatus = "pending" | "completed" | "expired" | "failed";

// The brokered live-view payload, returned ONLY to the owning participant by
// GET /api/browser/signin/:id/view. Short-lived by construction: it dies with the session.
export interface BrowserSigninView {
  requestId: string;
  siteLabel: string;
  liveViewUrl: string;
  expiresAt: string;
}

// Per-agent config stored in agent_integrations.config for integration_key 'browser'.
export interface BrowserIntegrationConfig {
  // The connection rows (one per site) this agent may drive. Empty = the agent can ask for a
  // sign-in but holds no profiles yet.
  connectionIds?: string[];
  // Write-gate. Default ON: browser_act goes through the confirmation card. Reads never do.
  requireApproval?: boolean;
}

// Max characters of extracted page text returned to the model in one browser_read. Pages are
// unbounded and the model pays for every token; truncation is explicit and reported.
export const BROWSER_READ_MAX_CHARS = 12_000;

// How long a sign-in live view stays open. Browserbase's free tier hard-caps a session at 15
// minutes; we release a few seconds early so the release is ours rather than a timeout.
export const BROWSER_SIGNIN_TTL_MS = 14 * 60 * 1000;
