import { Router } from "express";
import { isAdminWindow, isModelProvider, type AdminWindow } from "@jungle/shared";
import * as auth from "../../auth";
import * as db from "../../db";
import * as spend from "../../services/spend";
import { requireAdmin } from "../../admins";
import { ApiError, wrap } from "../errors";

// Operator-only platform analytics: how many accounts exist, what their agents are doing, and
// what it costs. Every route here is gated by requireAdmin (the ADMIN_EMAILS allowlist checked
// against the VERIFIED token email) — this is the one part of the API that deliberately reads
// across workspace boundaries, so the gate is applied router-wide rather than per route.
//
// Dollar figures are the Agent SDK's own per-turn estimates; see shared/src/admin.ts.

const router = Router();

router.use("/api/admin", requireAdmin);

function windowOf(req: { query: Record<string, unknown> }): AdminWindow {
  const w = req.query.window;
  return isAdminWindow(w) ? w : "7d";
}

// Platform totals, the daily spend series, and the model split.
router.get(
  "/api/admin/overview",
  wrap(async (req, res) => {
    res.json(await db.adminOverview(windowOf(req)));
  }),
);

// One row per account: workspaces, agents, turns, tokens, spend in the window.
router.get(
  "/api/admin/accounts",
  wrap(async (req, res) => {
    res.json({ accounts: await db.adminAccounts(windowOf(req)) });
  }),
);

// Per-agent breakdown — all agents, or one account's when ?account=<key> is given (the key comes
// from the accounts response; it's an email or a participant sentinel, never trusted as a filter
// beyond an equality match).
router.get(
  "/api/admin/agents",
  wrap(async (req, res) => {
    const account = req.query.account ? String(req.query.account) : null;
    res.json({ agents: await db.adminAgentUsage(windowOf(req), account) });
  }),
);

// The recent-turn tail.
router.get(
  "/api/admin/activity",
  wrap(async (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ items: await db.adminActivity(windowOf(req), Number.isFinite(limit) ? limit : 50) });
  }),
);

// --- Spend caps -----------------------------------------------------------------------------
//
// One account's daily cap per provider, plus what it has spent today. Unlike the routes above
// these are WRITES, and the thing they write bounds real money — but they need no gate beyond the
// router-wide requireAdmin, since setting a cap is exactly the operator privilege that grants.
//
// `account` is an AdminAccount.key (an email or a `participant:<id>` sentinel). It is never
// validated against a list of known accounts on purpose: a cap may be set for an account that has
// no usage yet, and an unmatched key simply caps nothing.

function accountOf(req: { query: Record<string, unknown> }): string {
  const account = String(req.query.account ?? "").trim();
  if (!account) throw new ApiError(400, "account is required");
  return account;
}

router.get(
  "/api/admin/limits",
  wrap(async (req, res) => {
    res.json(await spend.accountLimits(accountOf(req)));
  }),
);

// Set one provider's cap. Body: { account, provider, limitUsd }.
//   limitUsd: a number  -> that many dollars per day ($0 blocks the account outright)
//   limitUsd: null      -> explicitly uncapped, pinned even if the platform default changes
//   reset: true         -> drop the override and fall back to the platform default
router.put(
  "/api/admin/limits",
  wrap(async (req, res) => {
    const body = (req.body ?? {}) as {
      account?: unknown;
      provider?: unknown;
      limitUsd?: unknown;
      reset?: unknown;
    };
    const account = String(body.account ?? "").trim();
    if (!account) throw new ApiError(400, "account is required");
    if (!isModelProvider(body.provider)) throw new ApiError(400, "unknown provider");

    const reset = body.reset === true;
    let limitUsd: number | null = null;
    if (!reset && body.limitUsd != null) {
      const n = Number(body.limitUsd);
      // Reject rather than clamp: a typo'd cap is a money decision, and silently rounding one to
      // something valid is worse than making the operator retype it.
      if (!Number.isFinite(n) || n < 0) throw new ApiError(400, "limitUsd must be a number >= 0, or null for unlimited");
      if (n > 100_000) throw new ApiError(400, "limitUsd is implausibly large");
      limitUsd = Math.round(n * 100) / 100; // the column is numeric(12,2)
    }

    const by = auth.authedUser(req)?.email ?? null;
    res.json(await spend.setAccountLimit(account, body.provider, limitUsd, { reset, byEmail: by }));
  }),
);

export default router;
