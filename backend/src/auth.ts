import "./env";
import { readFileSync } from "node:fs";
import { initializeApp, cert, getApps, type App } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import type { NextFunction, Request, Response } from "express";

// Firebase Admin verifies the Google ID tokens the frontend sends. Credentials come from a
// service-account JSON, provided either inline (FIREBASE_SERVICE_ACCOUNT) or as a file path
// (GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_SERVICE_ACCOUNT_PATH). When none is set, auth is
// "not configured" and the backend falls back to the dev (?as= / ?participantId=) path so the
// existing test suite keeps working untouched.

function loadServiceAccount(): Record<string, unknown> | null {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline && inline.trim().startsWith("{")) {
    try {
      return JSON.parse(inline);
    } catch {
      console.error("FIREBASE_SERVICE_ACCOUNT is set but not valid JSON — ignoring");
      return null;
    }
  }
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (path) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      console.error("could not read service account at", path, String((e as Error).message));
      return null;
    }
  }
  return null;
}

let app: App | null = null;
const serviceAccount = loadServiceAccount();
if (serviceAccount) {
  app = getApps()[0] ?? initializeApp({ credential: cert(serviceAccount as any) });
}

export function firebaseConfigured(): boolean {
  return app != null;
}

// When auth isn't configured (tests/local), or AUTH_DEV_BYPASS=1 is set explicitly, the
// backend trusts ?participantId=/?as= so the existing flow and Playwright suites still work.
export const DEV_BYPASS = !firebaseConfigured() || process.env.AUTH_DEV_BYPASS === "1";

export interface AuthUser {
  uid: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

function toUser(d: DecodedIdToken): AuthUser {
  return {
    uid: d.uid,
    email: d.email ?? null,
    name: (d.name as string | undefined) ?? null,
    picture: (d.picture as string | undefined) ?? null,
  };
}

// Verify a Firebase ID token; throws if invalid/expired or auth isn't configured.
export async function verifyIdToken(idToken: string): Promise<AuthUser> {
  if (!app) throw new Error("auth not configured");
  return toUser(await getAuth(app).verifyIdToken(idToken));
}

function bearer(req: Request): string | null {
  const h = req.header("authorization") || req.header("Authorization");
  if (h && h.startsWith("Bearer ")) return h.slice(7).trim();
  return null;
}

// Attaches req.auth when a valid token is present (does not reject — use requireAuth for that).
export async function attachAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = bearer(req);
  if (token && app) {
    try {
      (req as Request & { auth?: AuthUser }).auth = await verifyIdToken(token);
    } catch {
      /* leave unauthenticated; requireAuth will 401 if needed */
    }
  }
  next();
}

// Gate a route on a verified Firebase user. 401s when auth is configured and no valid token.
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = bearer(req);
  if (!app) {
    res.status(503).json({ error: "auth not configured on this server" });
    return;
  }
  if (!token) {
    res.status(401).json({ error: "missing bearer token" });
    return;
  }
  try {
    (req as Request & { auth?: AuthUser }).auth = await verifyIdToken(token);
    next();
  } catch (e) {
    res.status(401).json({ error: `invalid token: ${String((e as Error).message ?? e)}` });
  }
}

export function authedUser(req: Request): AuthUser | null {
  return (req as Request & { auth?: AuthUser }).auth ?? null;
}
