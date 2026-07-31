import Browserbase from "@browserbasehq/sdk";
import { chromium, type Browser, type Page, type BrowserContext } from "playwright-core";
import {
  BROWSER_READ_MAX_CHARS,
  BROWSER_SIGNIN_TTL_MS,
  browserSite,
  type BrowserSite,
} from "@jungle/shared";
import * as db from "../db";
import { broadcastWorkspace } from "../ws/appSocket";

// The browser integration's engine: a real, logged-in Chrome in the cloud that agents drive for
// sites with no usable API (LinkedIn, X writes, …).
//
// Why all of this lives in the BACKEND rather than the runner: Browserbase's only credential is a
// long-lived account API key. Every other integration ships the runner a short-lived OAuth token,
// but there is no such thing here — handing the raw key to per-agent containers would break "the
// backend is the sole holder of the provider key". So the runner sends browser_tool frames and
// this module does the work, which also puts the domain allowlist somewhere an agent cannot reach.
//
// Two lifecycles live here:
//
//   1. SIGN-IN. A human logs into the real site by hand inside a live view. We watch the cookie
//      jar for the site's auth cookie — never by navigating, which would yank the page out from
//      under them mid-2FA. On success the Browserbase context id is persisted as an ordinary
//      integration_connections row. No password ever touches Jungle.
//
//   2. TOOL USE. Agents navigate/read/act against a session attached to that context. Sessions are
//      pooled per connection and released on idle, because a forgotten session bills until its own
//      timeout and the free tier's entire monthly allowance is about four of those.

const API_KEY = process.env.BROWSERBASE_API_KEY ?? "";
const FRONTEND_URL = (process.env.FRONTEND_URL ?? "").replace(/\/$/, "");

// Browserbase's free tier hard-caps a session at 15 minutes. Ask for slightly less so the release
// is ours (deterministic, logged) rather than a silent server-side timeout.
const SESSION_TIMEOUT_S = 890;
// How long a pooled tool session survives with no calls. Long enough that a multi-step task
// (navigate → read → act → read) reuses one browser; short enough that an abandoned turn doesn't
// bill for a quarter hour.
const POOL_IDLE_MS = 90_000;
const SIGNIN_POLL_MS = 8_000;

export function isBrowserConfigured(): boolean {
  return Boolean(API_KEY);
}

let _bb: Browserbase | null = null;
function bb(): Browserbase {
  if (!_bb) _bb = new Browserbase({ apiKey: API_KEY });
  return _bb;
}

// --- session plumbing -------------------------------------------------------------------------

interface LiveSession {
  sessionId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

// Open a session bound to `contextId`. persist:true is what makes cookies written during the
// session flow BACK into the context; without it a login would evaporate when the session ends.
async function openSession(contextId: string): Promise<LiveSession> {
  const session = await bb().sessions.create({
    browserSettings: { context: { id: contextId, persist: true } },
    timeout: SESSION_TIMEOUT_S,
  });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  // A Browserbase session comes up with exactly one context and one blank page. Reuse them: a
  // second context would not inherit the persisted cookies, so the agent would appear logged out.
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  if (!context || !page) throw new Error("Browserbase session came up with no default page");
  return { sessionId: session.id, browser, context, page };
}

async function releaseSession(s: LiveSession): Promise<void> {
  try {
    await s.browser.close();
  } catch {
    // The CDP connection may already be gone; the release below is what actually stops billing.
  }
  try {
    await bb().sessions.update(s.sessionId, { status: "REQUEST_RELEASE" });
  } catch (e) {
    console.error(`browser: could not release session ${s.sessionId}:`, e);
  }
}

// --- tool session pool ------------------------------------------------------------------------

interface PooledSession extends LiveSession {
  idleTimer: NodeJS.Timeout;
}

const pool = new Map<string, PooledSession>(); // connectionId -> session

function armIdleRelease(connectionId: string, s: PooledSession): void {
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    pool.delete(connectionId);
    void releaseSession(s);
  }, POOL_IDLE_MS);
  // Don't let a pooled browser hold the process open at shutdown.
  s.idleTimer.unref?.();
}

async function sessionFor(connectionId: string, contextId: string): Promise<PooledSession> {
  const existing = pool.get(connectionId);
  if (existing) {
    // A pooled browser can die under us (session timeout, Browserbase restart). Cheap liveness
    // probe: if the CDP connection dropped, drop the entry and open a fresh one.
    if (existing.browser.isConnected()) {
      armIdleRelease(connectionId, existing);
      return existing;
    }
    clearTimeout(existing.idleTimer);
    pool.delete(connectionId);
  }
  const fresh = await openSession(contextId);
  const pooled: PooledSession = { ...fresh, idleTimer: setTimeout(() => {}, 0) };
  pool.set(connectionId, pooled);
  armIdleRelease(connectionId, pooled);
  return pooled;
}

// Release everything (process shutdown). Best-effort and parallel — we're on the way out.
export async function shutdownBrowserSessions(): Promise<void> {
  const all = [...pool.values()];
  pool.clear();
  await Promise.allSettled(all.map((s) => {
    clearTimeout(s.idleTimer);
    return releaseSession(s);
  }));
}

// --- liveness ---------------------------------------------------------------------------------

// Is this profile still logged in? Navigate somewhere that requires auth and see whether we stay.
// Both signals matter: the URL check catches a redirect to a login wall, and the selector check
// catches a wall served at the right URL.
async function probeLoggedIn(page: Page, site: BrowserSite): Promise<boolean> {
  await page.goto(site.probeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2000); // let client-side redirects settle before judging the URL
  if (site.loggedOutMarkers.some((m) => page.url().includes(m))) return false;
  try {
    await page.waitForSelector(site.loggedInSelector, { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

// --- sign-in ----------------------------------------------------------------------------------

function signinUrl(requestId: string): string {
  return `${FRONTEND_URL}/browser-signin/${requestId}`;
}

function announce(participant: db.Participant, r: db.BrowserSigninRequestRow, site: BrowserSite): void {
  broadcastWorkspace(participant.workspace_id, {
    type: "browser_signin_changed",
    requestId: r.id,
    site: site.key,
    siteLabel: site.label,
    status: r.status,
    participantId: participant.id,
  });
}

export interface StartSigninResult {
  requestId: string;
  url: string;
  siteLabel: string;
  expiresAt: string;
}

// Begin a sign-in: create (or reuse) the Browserbase context, open a session on it, record the
// request, and start watching the cookie jar. Returns the BROKERED Jungle url — never the
// Browserbase live-view url, which is a bearer capability and must not travel through a message.
export async function startSignin(
  participant: db.Participant,
  agentId: string | null,
  siteKey: string,
): Promise<StartSigninResult> {
  const site = browserSite(siteKey);
  if (!site) throw new Error(`Unknown site "${siteKey}"`);
  if (!isBrowserConfigured()) throw new Error("Browser integration is not configured (BROWSERBASE_API_KEY)");

  // A second ask while one is already open should hand back the SAME live view rather than open a
  // competing session — two live views for one login is confusing and bills twice.
  const open = await db.findOpenBrowserSigninRequest(participant.id, site.key);
  if (open) {
    return {
      requestId: open.id,
      url: signinUrl(open.id),
      siteLabel: site.label,
      expiresAt: open.expires_at,
    };
  }

  // Reuse this participant's existing context for the site when there is one, so re-authing after
  // an expiry tops up the same profile instead of stranding it (contexts live until deleted).
  const existing = (await db.listIntegrationConnectionsForKey(participant.id, "browser")).find(
    (c) => (c.extra as { site?: string }).site === site.key,
  );
  const contextId = existing?.access_token ?? (await bb().contexts.create()).id;

  const session = await openSession(contextId);
  await session.page
    .goto(site.loginUrl, { waitUntil: "domcontentloaded", timeout: 45_000 })
    .catch((e) => console.error(`browser: could not open ${site.loginUrl}:`, e));

  const row = await db.createBrowserSigninRequest({
    participantId: participant.id,
    agentId,
    site: site.key,
    contextId,
    sessionId: session.sessionId,
    expiresAt: new Date(Date.now() + BROWSER_SIGNIN_TTL_MS),
  });
  announce(participant, row, site);
  void watchForSignin(row.id, participant, site, session, contextId, existing?.id ?? null);

  return {
    requestId: row.id,
    url: signinUrl(row.id),
    siteLabel: site.label,
    expiresAt: row.expires_at,
  };
}

// Poll the cookie jar until the site's auth cookie appears, then confirm with a real probe and
// persist the connection. Polling cookies (rather than navigating) is deliberate: navigating mid
// sign-in would interrupt a 2FA flow the human is halfway through.
async function watchForSignin(
  requestId: string,
  participant: db.Participant,
  site: BrowserSite,
  session: LiveSession,
  contextId: string,
  existingConnectionId: string | null,
): Promise<void> {
  const deadline = Date.now() + BROWSER_SIGNIN_TTL_MS - 30_000;
  let authed = false;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SIGNIN_POLL_MS));
      // The request can be cancelled or swept out from under us.
      const current = await db.getBrowserSigninRequest(requestId);
      if (!current || current.status !== "pending") return;
      let cookies;
      try {
        cookies = await session.context.cookies();
      } catch (e) {
        console.error(`browser: signin ${requestId} lost its session:`, e);
        break;
      }
      if (cookies.some((c) => c.name === site.authCookie && c.value)) {
        authed = true;
        break;
      }
    }

    // The cookie is necessary but not sufficient — a half-finished login can set it. Confirm a
    // real authed page renders before telling an agent it has a working profile.
    if (authed && (await probeLoggedIn(session.page, site).catch(() => false))) {
      const connectionId = await persistProfile(participant, site, contextId, existingConnectionId);
      await db.updateBrowserSigninRequest(requestId, {
        status: "completed",
        sessionId: null,
        connectionId,
      });
    } else {
      await db.updateBrowserSigninRequest(requestId, {
        status: authed ? "failed" : "expired",
        sessionId: null,
      });
    }
  } catch (e) {
    console.error(`browser: signin watcher ${requestId} failed:`, e);
    await db
      .updateBrowserSigninRequest(requestId, { status: "failed", sessionId: null })
      .catch(() => {});
  } finally {
    await releaseSession(session);
    const final = await db.getBrowserSigninRequest(requestId).catch(() => null);
    if (final) announce(participant, final, site);
  }
}

// A completed sign-in becomes an ordinary connection row: access_token is the Browserbase context
// id, which IS the credential. Reviving an existing row (rather than adding a second) is what
// makes the Reconnect affordance work — the agent's config keeps pointing at the same id.
async function persistProfile(
  participant: db.Participant,
  site: BrowserSite,
  contextId: string,
  existingConnectionId: string | null,
): Promise<string> {
  const extra = { site: site.key, lastVerifiedAt: new Date().toISOString() };
  if (existingConnectionId) {
    // Re-auth of a profile we already had: same context, so the only real change is clearing
    // needs_reconnect and re-stamping the verification time.
    await db.updateIntegrationConnectionById(existingConnectionId, {
      externalAccount: site.label,
      accessToken: contextId,
      refreshToken: null,
      accessExpiresAt: null,
      scopes: null,
      extra,
    });
    await db.setIntegrationNeedsReconnectById(existingConnectionId, false);
    return existingConnectionId;
  }
  const row = await db.createIntegrationConnection({
    participantId: participant.id,
    key: "browser",
    externalAccount: site.label,
    // The context id is the credential — there is no token to store, and that is the point.
    accessToken: contextId,
    refreshToken: null,
    accessExpiresAt: null,
    scopes: null,
    extra,
  });
  return row.id;
}

// The brokered live view. Called only by the route, only after it has checked that the viewer IS
// the participant who must sign in. Minting here (rather than storing the URL) keeps the
// capability out of the database and out of every list payload.
export async function liveViewFor(requestId: string, viewerId: string): Promise<{ url: string; siteLabel: string; expiresAt: string } | null> {
  const row = await db.getBrowserSigninRequest(requestId);
  if (!row || row.participant_id !== viewerId || row.status !== "pending" || !row.session_id) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  const site = browserSite(row.site);
  const { debuggerFullscreenUrl } = await bb().sessions.debug(row.session_id);
  return {
    url: debuggerFullscreenUrl,
    siteLabel: site?.label ?? row.site,
    expiresAt: row.expires_at,
  };
}

// --- agent tools ------------------------------------------------------------------------------

export interface BrowserToolOutcome {
  ok: boolean;
  error?: string;
  text?: string;
  needsSignin?: boolean;
  requestId?: string;
}

// Enforce the per-site domain allowlist. This is the main thing standing between a prompt-injected
// agent and a live authenticated session: without it, a malicious page could send the agent to a
// password-reset flow or an attacker-controlled collector while holding the user's cookies.
function allowedUrl(site: BrowserSite, raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const ok = site.allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
  return ok ? url : null;
}

const PAGE_TEXT_JS = `document.body ? document.body.innerText : ""`;

// Accessible names of things worth clicking, deduped. Capped twice: 400 elements scanned (a feed
// can carry thousands) and 60 returned, which is enough for a model to choose a target without
// paying for the whole DOM.
const PAGE_ACTIONS_JS = `(() => {
  const out = [];
  const els = document.querySelectorAll(
    "button, a[href], input, textarea, [role='button'], [role='link'], [role='textbox']"
  );
  for (const el of Array.from(els).slice(0, 400)) {
    const name = (
      el.getAttribute("aria-label") ||
      el.innerText ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      ""
    ).trim().replace(/\\s+/g, " ").slice(0, 80);
    if (name) out.push(el.tagName.toLowerCase() + ": " + name);
  }
  return Array.from(new Set(out)).slice(0, 60);
})()`;

// The page, rendered for a model: title, url, trimmed text, and the interactive elements it can
// name in a browser_act call. Deliberately not a screenshot — text plus named affordances is
// cheaper and more reliable, and it keeps the agent off pixel coordinates.
async function renderPage(page: Page): Promise<string> {
  const [title, url] = [await page.title().catch(() => ""), page.url()];
  // These two snippets are passed as STRINGS rather than closures on purpose: they execute inside
  // the page, so they reference browser globals (document, HTMLElement) that the backend's
  // tsconfig deliberately doesn't include. Adding "dom" to lib to satisfy them would leak browser
  // globals into every Node file in the backend — a much worse trade than losing type inference on
  // eight lines that run somewhere else entirely.
  const text = ((await page.evaluate(PAGE_TEXT_JS).catch(() => "")) as string).replace(
    /\n{3,}/g,
    "\n\n",
  );
  const clipped = text.length > BROWSER_READ_MAX_CHARS;
  const body = clipped ? `${text.slice(0, BROWSER_READ_MAX_CHARS)}\n…[truncated]` : text;

  // Accessible names of things worth clicking. Capped — a feed can carry hundreds and the model
  // only needs enough to choose.
  const actions = ((await page.evaluate(PAGE_ACTIONS_JS).catch(() => [])) as string[]) ?? [];

  return [
    `# ${title}`,
    url,
    "",
    body || "(no visible text)",
    "",
    actions.length ? `Interactive elements:\n${actions.map((a) => `- ${a}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// Resolve a natural-language target ("the Connect button") to a locator. Accessible-name first,
// visible text as a fallback — never a raw CSS selector from the model, which would let a page's
// own content steer the agent at arbitrary DOM.
function locate(page: Page, target: string) {
  return page
    .getByRole("button", { name: target })
    .or(page.getByRole("link", { name: target }))
    .or(page.getByRole("textbox", { name: target }))
    .or(page.getByLabel(target))
    .or(page.getByPlaceholder(target))
    .or(page.getByText(target, { exact: false }))
    .first();
}

// One browser verb for one agent. `connections` are the profiles this agent may drive, already
// resolved from its integration config by the caller.
export async function runBrowserTool(
  participant: db.Participant,
  agentId: string,
  tool: "signin" | "status" | "navigate" | "read" | "act",
  input: { site?: string; url?: string; action?: "click" | "type" | "press"; target?: string; text?: string },
): Promise<BrowserToolOutcome> {
  if (!isBrowserConfigured()) return { ok: false, error: "The browser integration is not configured on this server." };

  const conns = (await db.listIntegrationConnectionsForKey(participant.id, "browser")).map((c) => ({
    row: c,
    site: (c.extra as { site?: string }).site ?? "",
  }));

  if (tool === "status") {
    if (!conns.length) return { ok: true, text: "No browser profiles yet. Use browser_signin to ask for one." };
    return {
      ok: true,
      text: conns
        .map(({ row, site }) => {
          const label = browserSite(site)?.label ?? site;
          return `- ${label}${row.needs_reconnect ? " (signed out — needs a new sign-in)" : " (ready)"}`;
        })
        .join("\n"),
    };
  }

  if (tool === "signin") {
    const siteKey = input.site ?? "";
    if (!browserSite(siteKey)) {
      return { ok: false, error: `Unknown site "${siteKey}". Known sites: linkedin, x.` };
    }
    try {
      const r = await startSignin(participant, agentId, siteKey);
      return {
        ok: true,
        requestId: r.requestId,
        text:
          `Sign-in requested for ${r.siteLabel}. Send this link to the person who owns the ` +
          `account and ask them to open it and log in — it expires at ${r.expiresAt}:\n\n${r.url}\n\n` +
          `Only they can open it. Once they're done, call browser_status to confirm, then retry ` +
          `what you were doing.`,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Everything below drives a real session, so it needs a live profile for the site.
  const siteKey = input.site ?? "";
  const site = browserSite(siteKey);
  if (!site) return { ok: false, error: `Unknown site "${siteKey}". Known sites: linkedin, x.` };
  const match = conns.find((c) => c.site === site.key);
  if (!match || match.row.needs_reconnect) {
    return {
      ok: false,
      needsSignin: true,
      error: `No usable ${site.label} session. Call browser_signin with site "${site.key}" and ask the owner to log in.`,
    };
  }

  try {
    const session = await sessionFor(match.row.id, match.row.access_token);

    if (tool === "navigate") {
      const url = allowedUrl(site, input.url ?? "");
      if (!url) {
        return {
          ok: false,
          error: `That URL is not allowed for ${site.label}. This profile may only visit: ${site.allowedDomains.join(", ")}.`,
        };
      }
      await session.page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
      await session.page.waitForTimeout(1500);
      // A navigation that lands on a login wall means the site killed the session — surface that
      // as needsSignin rather than handing the model a page of login form to reason about.
      if (site.loggedOutMarkers.some((m) => session.page.url().includes(m))) {
        await db.setIntegrationNeedsReconnectById(match.row.id, true);
        return {
          ok: false,
          needsSignin: true,
          error: `${site.label} has signed this profile out. Call browser_signin to get a fresh login.`,
        };
      }
      return { ok: true, text: await renderPage(session.page) };
    }

    if (tool === "read") return { ok: true, text: await renderPage(session.page) };

    // act
    const { action, target, text } = input;
    if (!action) return { ok: false, error: "act needs an action: click, type or press." };
    if (action === "press") {
      if (!text) return { ok: false, error: "press needs `text` (the key, e.g. \"Enter\")." };
      await session.page.keyboard.press(text);
    } else {
      if (!target) return { ok: false, error: `${action} needs a \`target\` describing the element.` };
      const loc = locate(session.page, target);
      if (action === "click") await loc.click({ timeout: 15_000 });
      else {
        if (text === undefined) return { ok: false, error: "type needs `text`." };
        await loc.fill(text, { timeout: 15_000 });
      }
    }
    await session.page.waitForTimeout(1500);
    return { ok: true, text: `Done.\n\n${await renderPage(session.page)}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
