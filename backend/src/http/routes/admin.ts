import { Router } from "express";
import { isAdminWindow, type AdminWindow } from "@jungle/shared";
import * as db from "../../db";
import { requireAdmin } from "../../admins";
import { wrap } from "../errors";

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

export default router;
