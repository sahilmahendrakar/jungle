import { Router } from "express";
import * as db from "../../db";
import { wrap, ApiError } from "../errors";
import { optInt } from "../validate";
import { requireRequester } from "../guards";

// The "work" read surfaces: the deliverables feed and message search. Both are requester-scoped
// (channels the requester belongs to) within their workspace.

const router = Router();

// The requester's deliverables feed, newest first. Page backwards with `before` = the smallest
// deliverable id already held. Live additions ride the WS as `deliverable_created` fan-outs.
router.get(
  "/api/deliverables",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const before = optInt(req.query.before);
    const limit = optInt(req.query.limit);
    const deliverables = await db.listDeliverables(me.workspace_id, me.id, { before, limit });
    res.json({ deliverables });
  }),
);

// Full-text message search across the requester's channels (the ⌘K palette).
router.get(
  "/api/search",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const q = String(req.query.q ?? "").trim();
    if (!q) throw new ApiError(400, "q is required");
    const limit = optInt(req.query.limit);
    const results = await db.searchMessages(me.workspace_id, me.id, q, limit ?? 30);
    res.json({ results });
  }),
);

export default router;
