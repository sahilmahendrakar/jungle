import "./env";
import type express from "express";
import * as auth from "./auth";
import * as db from "./db";
import { ApiError } from "./http/errors";
import { requester } from "./http/guards";

// Platform operators — the accounts allowed to see cross-workspace usage and spend (/api/admin/*,
// the frontend's /admin view). This is a PLATFORM role, unrelated to participants.role ('admin'
// there means workspace admin, which grants nothing here).
//
// The list is the ADMIN_EMAILS env var (comma-separated) when set, else the two founder accounts.

const DEFAULT_ADMIN_EMAILS = ["sahil.mahendrakar@gmail.com", "suhaaspk@gmail.com"];

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? DEFAULT_ADMIN_EMAILS.join(","))
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && ADMIN_EMAILS.has(email.trim().toLowerCase());
}

// Is this request from an operator? The email comes from the VERIFIED Firebase token — never from
// a participant row a client could have influenced. Under dev bypass (no Firebase) there is no
// verified email, so we fall back to the resolved dev participant's email, which is only as
// trustworthy as dev bypass itself (a local/test-only mode).
export async function isAdminRequest(req: express.Request): Promise<boolean> {
  const u = auth.authedUser(req);
  if (u) return isAdminEmail(u.email);
  if (!auth.DEV_BYPASS) return false;
  const me = await requester(req);
  return isAdminEmail((me as db.Participant & { email?: string | null } | null)?.email ?? null);
}

// Express middleware: 403 for anyone not on the allowlist. Deliberately the same 403 whether the
// caller is signed out, signed in, or unknown — the admin surface doesn't confirm its own shape.
export function requireAdmin(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
): void {
  void isAdminRequest(req)
    .then((ok) => next(ok ? undefined : new ApiError(403, "not permitted")))
    .catch(next);
}
