// Claude subscription (Max/Pro) auth — operator-only.
//
// An operator can paste a `claude setup-token` OAuth token into Settings; agents they create then
// bill turns to that personal Claude subscription instead of the org ANTHROPIC_API_KEY (the runner
// swaps CLAUDE_CODE_OAUTH_TOKEN into the CLI child env — see runner/src/runner.ts). This exists
// for first-party testing on our own subscription seat.
//
// It is deliberately NOT a customer feature: a subscription token is a personal, per-seat
// credential with personal rate limits, so the write path is gated to an email allowlist that only
// someone with shell access to the backend's .env can change.
//
// Note this is a NARROWER list than admins.ts: a platform operator may read cross-workspace usage
// without it being appropriate to spend someone else's subscription quota, so the two allowlists
// are deliberately separate and this one defaults to a single account.
import "./env";
import type express from "express";
import * as auth from "./auth";
import * as db from "./db";
import { requester } from "./http/guards";

const DEFAULT_SUBSCRIPTION_EMAILS = ["sahil.mahendrakar@gmail.com"];

const ALLOWED = new Set(
  (process.env.CLAUDE_SUBSCRIPTION_EMAILS ?? DEFAULT_SUBSCRIPTION_EMAILS.join(","))
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export function isSubscriptionEmail(email: string | null | undefined): boolean {
  return !!email && ALLOWED.has(email.trim().toLowerCase());
}

// May this request manage a subscription token? Mirrors admins.ts/isAdminRequest: the email comes
// from the VERIFIED Firebase token, never from a participant row a client could influence. Under
// dev bypass (no Firebase) we fall back to the resolved dev participant's email, which is only as
// trustworthy as dev bypass itself (a local/test-only mode).
export async function canManageSubscription(req: express.Request): Promise<boolean> {
  const u = auth.authedUser(req);
  if (u) return isSubscriptionEmail(u.email);
  if (!auth.DEV_BYPASS) return false;
  const me = await requester(req);
  return isSubscriptionEmail((me as (db.Participant & { email?: string | null }) | null)?.email ?? null);
}

// Shape check for a pasted token. `claude setup-token` mints an OAuth access token prefixed
// `sk-ant-oat`; rejecting an API key ("sk-ant-api…") up front turns a silent per-turn 401 into an
// immediate, obvious error at paste time.
export function looksLikeOauthToken(token: string): boolean {
  return /^sk-ant-oat[\w-]/.test(token) && token.length >= 40;
}
