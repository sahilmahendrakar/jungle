import { Router } from "express";
import * as db from "../../db";
import * as auth from "../../auth";
import * as runners from "../../runners";
import { canManageSubscription, looksLikeOauthToken } from "../../subscription";
import { wrap, ApiError } from "../errors";
import { requireRequester } from "../guards";

const router = Router();

// Operator-only: store a `claude setup-token` OAuth token so the agents this operator creates bill
// turns to their Claude subscription instead of the org API key. See backend/src/subscription.ts
// for why this is allowlisted rather than a customer-facing setting.
//
// The token is write-only across this API: it goes in, and afterwards callers can only learn
// WHETHER one is set. Reads happen server-side in buildConfigure.

// Does the signed-in operator have a token stored, and may they manage one at all? `allowed` is
// what the client uses to decide whether to render the field — a non-operator gets
// {allowed:false} and never sees it.
router.get(
  "/api/claude-subscription",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    if (!(await canManageSubscription(req))) return res.json({ allowed: false, configured: false });
    res.json({ allowed: true, configured: await db.hasClaudeOauthToken(me.id) });
  }),
);

// Store (or replace) the token, then push a fresh `configure` to every connected runner of an
// agent this operator created, so the switch takes effect on the next turn — no container
// re-provision, same as a model change.
router.put(
  "/api/claude-subscription",
  auth.requireAuth,
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    if (!(await canManageSubscription(req))) throw new ApiError(404, "not found");
    const token = String(req.body?.token ?? "").trim();
    if (!token) throw new ApiError(400, "token required");
    if (!looksLikeOauthToken(token)) {
      throw new ApiError(400, "expected a `claude setup-token` OAuth token (starts with sk-ant-oat)");
    }
    await db.setClaudeOauthToken(me.id, token);
    await reconfigureOwnedAgents(me.id);
    res.json({ allowed: true, configured: true });
  }),
);

// Clear it — those agents fall straight back to the org ANTHROPIC_API_KEY on their next turn.
router.delete(
  "/api/claude-subscription",
  auth.requireAuth,
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    if (!(await canManageSubscription(req))) throw new ApiError(404, "not found");
    await db.setClaudeOauthToken(me.id, null);
    await reconfigureOwnedAgents(me.id);
    res.json({ allowed: true, configured: false });
  }),
);

// Re-push `configure` to each connected agent this operator created. reconfigure() no-ops for
// agents whose runner isn't connected — they pick the new credential up from the `configure` they
// get on their next `hello`, so nothing is missed.
async function reconfigureOwnedAgents(ownerId: string): Promise<void> {
  for (const agentId of await db.listAgentIdsCreatedBy(ownerId)) {
    await runners.reconfigure(agentId);
  }
}

export default router;
