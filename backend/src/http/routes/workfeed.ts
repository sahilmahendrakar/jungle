import { Router } from "express";
import * as db from "../../db";
import { wrap, ApiError } from "../errors";
import { optInt, optString } from "../validate";
import { requireRequester } from "../guards";
import { parseFilterQuery } from "../../searchFilters";
import type { ActivityFilters } from "@jungle/shared";

// The "work" read surfaces: the unified activity feed, the deliverables feed, and message
// search. All are requester-scoped (channels the requester belongs to) within their workspace,
// and activity + search speak the same composable filter-token language (see searchFilters.ts).

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

// The unified activity feed: messages + deliverables, composably filtered. Filters arrive both
// as explicit params (the page's pills/chips) and as tokens inside `q` (deep links / power
// users); params win on conflicts. Page backwards with `before` = the oldest item's created_at.
router.get(
  "/api/activity",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const filters = activityFiltersFromQuery(req.query as Record<string, unknown>);
    const before = optString(req.query.before);
    const limit = optInt(req.query.limit);
    const { items, hasMore } = await db.listActivity(me.workspace_id, me.id, filters, {
      before,
      limit,
    });
    res.json({ items, hasMore });
  }),
);

// Message search across the requester's channels (the ⌘K palette). The query string carries the
// same filter tokens as the activity feed ("deploy from:@pip in:#general"); `type:deliverables`
// switches the search to the deliverables index instead of message bodies.
router.get(
  "/api/search",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const q = String(req.query.q ?? "").trim();
    if (!q) throw new ApiError(400, "q is required");
    const limit = optInt(req.query.limit);
    const filters = parseFilterQuery(q);
    if (filters.type === "deliverables") {
      const deliverables = await db.searchDeliverables(me.workspace_id, me.id, filters, limit ?? 30);
      res.json({ deliverables });
      return;
    }
    const results = await db.searchMessages(me.workspace_id, me.id, filters, limit ?? 30);
    res.json({ results });
  }),
);

// Merge explicit activity params over whatever the `q` tokens parsed to.
function activityFiltersFromQuery(query: Record<string, unknown>): ActivityFilters {
  const filters = parseFilterQuery(String(query.q ?? ""));
  const type = optString(query.type);
  if (type === "messages" || type === "deliverables" || type === "all") filters.type = type;
  const direction = optString(query.direction);
  if (direction === "sent" || direction === "received" || direction === "mentions") {
    filters.direction = direction;
  }
  const from = optString(query.from);
  if (from) filters.from = from.replace(/^@/, "").toLowerCase();
  const to = optString(query.to);
  if (to) filters.to = to.replace(/^@/, "").toLowerCase();
  const person = optString(query.person);
  if (person) filters.person = person.replace(/^@/, "").toLowerCase();
  const inParam = optString(query.in);
  if (inParam) {
    if (inParam.startsWith("@")) filters.inDm = inParam.slice(1).toLowerCase();
    else filters.inChannel = inParam.replace(/^#/, "").toLowerCase();
  }
  const kind = optString(query.kind);
  if (kind) filters.kind = kind;
  return filters;
}

export default router;
