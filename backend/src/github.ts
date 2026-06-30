import "./env";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import * as db from "./db";

// GitHub App user-OAuth credentials (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET in .env).
const CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? "";
// Must exactly match the Callback URL registered on the GitHub App.
export const REDIRECT_URI =
  process.env.GITHUB_REDIRECT_URI ?? "http://localhost:3001/auth/github/callback";
// PEM private key for App (installation) auth — the bot-identity path.
const APP_PEM_PATH =
  process.env.GITHUB_APP_PEM ?? "/home/ec2-user/.config/jungle/github-app.pem";

const API = "https://api.github.com";
const UA = "jungle-mvp";
// The hosted GitHub MCP server — gives agents PRs/commits/issues over their repos.
export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

export function isConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

// --- GitHub App (installation) auth: the bot-identity path agents use ---

let cachedPem: string | null = null;
function appPrivateKey(): string {
  if (cachedPem == null) {
    // Prefer the inline PEM from .env (GITHUB_APP_PRIVATE_KEY); fall back to a file path.
    const inline = process.env.GITHUB_APP_PRIVATE_KEY;
    cachedPem =
      inline && inline.includes("PRIVATE KEY")
        ? inline.replace(/\\n/g, "\n")
        : readFileSync(APP_PEM_PATH, "utf8");
  }
  return cachedPem;
}

export function appAuthConfigured(): boolean {
  try {
    return Boolean(CLIENT_ID) && appPrivateKey().includes("PRIVATE KEY");
  } catch {
    return false;
  }
}

const b64url = (b: Buffer | string): string =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Short-lived (≤10 min) JWT identifying the App itself. iss = Client ID (GitHub accepts it
// in place of the numeric App ID).
function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: CLIENT_ID, iat: now - 30, exp: now + 540 }));
  const signature = b64url(
    createSign("RSA-SHA256").update(`${header}.${payload}`).sign(appPrivateKey()),
  );
  return `${header}.${payload}.${signature}`;
}

// installation access token cache, keyed by "owner/repo"
const installTokenCache = new Map<string, { token: string; expMs: number }>();

// Mint an installation access token scoped to one repo (Contents + Pull requests R/W).
// Cached until ~5 min before expiry. This is the credential agents use for both git
// (repo mount) and the GitHub MCP server.
export async function installationTokenForRepo(repo: string): Promise<string> {
  const cached = installTokenCache.get(repo);
  if (cached && cached.expMs - Date.now() > 5 * 60_000) return cached.token;

  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`repo must be "owner/name", got "${repo}"`);
  const jwt = appJwt();
  const inst = await ghJson<{ id: number }>(`/repos/${owner}/${name}/installation`, jwt);
  const tok = await ghJson<{ token: string; expires_at: string }>(
    `/app/installations/${inst.id}/access_tokens`,
    jwt,
    {
      method: "POST",
      body: JSON.stringify({
        repositories: [name],
        permissions: { contents: "write", pull_requests: "write" },
      }),
    },
  );
  installTokenCache.set(repo, { token: tok.token, expMs: new Date(tok.expires_at).getTime() });
  return tok.token;
}

// Where we send a human to grant access. `state` is our CSRF/round-trip token.
export function authorizeUrl(state: string): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("state", state);
  return u.toString();
}

interface TokenResponse {
  access_token: string;
  expires_in?: number; // seconds (8h for GitHub App user tokens)
  refresh_token?: string;
  refresh_token_expires_in?: number; // seconds (~6mo)
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": UA },
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as TokenResponse;
  if (json.error) throw new Error(`github oauth: ${json.error} — ${json.error_description ?? ""}`);
  if (!json.access_token) throw new Error("github oauth: no access_token in response");
  return json;
}

const expiryDate = (secs?: number): Date | null =>
  typeof secs === "number" ? new Date(Date.now() + secs * 1000) : null;

// Exchange the callback `code` for tokens, fetch the GitHub user, and persist the identity.
export async function exchangeCodeAndStore(
  participantId: string,
  code: string,
): Promise<{ login: string }> {
  const tok = await postToken({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const user = await ghJson<{ login: string; id: number }>("/user", tok.access_token);
  await db.upsertGithubIdentity({
    participantId,
    githubLogin: user.login,
    githubUserId: user.id,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? null,
    accessExpiresAt: expiryDate(tok.expires_in),
    refreshExpiresAt: expiryDate(tok.refresh_token_expires_in),
    scopes: tok.scope ?? null,
  });
  return { login: user.login };
}

// Return a valid access token for the participant, refreshing if it's expired/near-expiry.
export async function getValidToken(participantId: string): Promise<string> {
  const id = await db.getGithubIdentity(participantId);
  if (!id) throw new Error("participant has not connected GitHub");
  const exp = id.access_expires_at ? new Date(id.access_expires_at).getTime() : Infinity;
  if (exp - Date.now() > 60_000) return id.access_token; // still good (>60s headroom)
  if (!id.refresh_token) throw new Error("access token expired and no refresh token; reconnect GitHub");

  const tok = await postToken({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: id.refresh_token,
  });
  await db.updateGithubTokens({
    participantId,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? id.refresh_token,
    accessExpiresAt: expiryDate(tok.expires_in),
    refreshExpiresAt: expiryDate(tok.refresh_token_expires_in),
  });
  return tok.access_token;
}

// --- GitHub REST helpers ---

async function gh(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(API + path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": UA,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function ghJson<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await gh(path, token, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`github ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export interface OpenPrInput {
  participantId: string;
  repo: string; // "owner/name"
  title: string;
  body?: string;
  headBranch?: string; // defaults to a generated jungle/* branch
  baseBranch?: string; // defaults to the repo's default branch
  files: { path: string; content: string }[]; // file contents (text) to write on the branch
}

export interface OpenPrResult {
  url: string;
  number: number;
  branch: string;
}

export interface OpenPrFields {
  repo: string; // "owner/name"
  title: string;
  body?: string;
  headBranch?: string;
  baseBranch?: string;
  files: { path: string; content: string }[];
}

// Open a PR using the participant's connected user token.
export async function openPullRequest(input: OpenPrInput): Promise<OpenPrResult> {
  return openPrWithToken(await getValidToken(input.participantId), input);
}

// Open a PR as the GitHub App (bot identity) using an installation token scoped to the repo.
export async function openPrAsBot(input: OpenPrFields): Promise<OpenPrResult> {
  return openPrWithToken(await installationTokenForRepo(input.repo), input);
}

// Create a branch off base, write the files (one commit each), then open the PR. Files may
// be new or overwrite existing ones. Token can be a user token, installation token, or PAT.
export async function openPrWithToken(token: string, input: OpenPrFields): Promise<OpenPrResult> {
  if (!input.files?.length) throw new Error("at least one file is required");
  const [owner, repo] = input.repo.split("/");
  if (!owner || !repo) throw new Error(`repo must be "owner/name", got "${input.repo}"`);

  const repoInfo = await ghJson<{ default_branch: string }>(`/repos/${owner}/${repo}`, token);
  const base = input.baseBranch || repoInfo.default_branch;
  const head =
    input.headBranch || `jungle/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // base commit sha -> create the new branch ref
  const baseRef = await ghJson<{ object: { sha: string } }>(
    `/repos/${owner}/${repo}/git/ref/${encodeURIComponent(`heads/${base}`)}`,
    token,
  );
  await ghJson(`/repos/${owner}/${repo}/git/refs`, token, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${head}`, sha: baseRef.object.sha }),
  });

  // write each file on the branch (PUT contents; include sha if the file already exists)
  for (const f of input.files) {
    let sha: string | undefined;
    const cur = await gh(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(head)}`,
      token,
    );
    if (cur.ok) sha = ((await cur.json()) as { sha: string }).sha;
    await ghJson(`/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}`, token, {
      method: "PUT",
      body: JSON.stringify({
        message: `${input.title} — ${f.path}`,
        content: Buffer.from(f.content, "utf8").toString("base64"),
        branch: head,
        ...(sha ? { sha } : {}),
      }),
    });
  }

  const pr = await ghJson<{ html_url: string; number: number }>(
    `/repos/${owner}/${repo}/pulls`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ title: input.title, body: input.body ?? "", head, base }),
    },
  );
  return { url: pr.html_url, number: pr.number, branch: head };
}
