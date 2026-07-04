import { Router } from "express";
import * as db from "../../db";
import * as att from "../../attachments";
import { wrap, ApiError } from "../errors";
import { requireChannelMember, requireRequester } from "../guards";

const router = Router();

// Thread transcript (root + replies, seq order) for lazy-loading a thread the client doesn't
// already hold locally. Membership-gated; the root must live in the named channel.
router.get(
  "/api/channels/:id/threads/:rootId",
  wrap(async (req, res) => {
    const ctx = await requireChannelMember(req);
    const rootChannel = await db.getMessageChannelId(String(req.params.rootId));
    if (rootChannel !== ctx.channel.id) throw new ApiError(404, "thread not found in this channel");
    res.json((await db.getThreadMessages(String(req.params.rootId))).map(att.withUrls));
  }),
);

// Mark a thread read for the requester (participation-gated thread unreads): advance their
// per-thread last_read_seq to the thread's max seq, or a client-supplied `seq`.
router.post(
  "/api/threads/:rootId/read",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const channelId = await db.getMessageChannelId(String(req.params.rootId));
    if (!channelId) throw new ApiError(404, "thread not found");
    if (!(await db.isMember(channelId, me.id))) throw new ApiError(403, "not a member of this channel");
    const rawSeq = req.body?.seq;
    const seq = rawSeq != null && Number.isFinite(Number(rawSeq)) ? Number(rawSeq) : undefined;
    const lastReadSeq = await db.markThreadRead(String(req.params.rootId), me.id, seq);
    res.json({ ok: true, lastReadSeq });
  }),
);

// The requester's followed threads (authored root / replied / @mentioned) that have unread
// replies — the "Threads" sidebar view. Member-scoping is enforced inside the query.
router.get(
  "/api/threads/unread",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    res.json(await db.listUnreadThreads(me.id));
  }),
);

export default router;
