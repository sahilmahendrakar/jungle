import { Router } from "express";
import * as db from "../../db";
import * as att from "../../attachments";
import { fanOut } from "../../ws/appSocket";
import * as directory from "../../services/directory";
import { wrap, ApiError } from "../errors";
import { requireChannelMember, requireRequester } from "../guards";

const router = Router();

// Find-or-create the 1:1 DM channel between the requester and another participant (dedupes,
// unlike POST /channels). The first party is always the authenticated requester.
router.post(
  "/api/dms",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const { otherId } = req.body ?? {};
    if (!otherId) throw new ApiError(400, "otherId required");
    const id = await db.findOrCreateDm(me.id, String(otherId));
    res.status(201).json({ id, kind: "dm" });
  }),
);

// Create a channel; the creator is always a member. Logic in services/directory.ts (shared with
// the /mcp server).
router.post(
  "/api/channels",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const { name, memberHandles } = req.body ?? {};
    if (!name) throw new ApiError(400, "name required");
    const handles = Array.isArray(memberHandles) ? memberHandles.map(String) : [];
    res.status(201).json(await directory.createChannelAs(me, { name: String(name), memberHandles: handles }));
  }),
);

router.get(
  "/api/channels",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    res.json(await db.listChannels(me.id));
  }),
);

// Channels in the requester's workspace they haven't joined yet, for "Browse channels". Channels
// have no public/private flag — every channel is browsable and self-serve joinable (see join
// below).
router.get(
  "/api/channels/browse",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    res.json(await db.listUnjoinedChannels(me.workspace_id, me.id));
  }),
);

// Self-serve join: unlike POST /api/channels/:id/members, the requester doesn't need to already
// be a member. Logic in services/directory.ts.
router.post(
  "/api/channels/:id/join",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    res.json(await directory.joinChannelAs(me, String(req.params.id)));
  }),
);

router.get(
  "/api/channels/:id/messages",
  wrap(async (req, res) => {
    const ctx = await requireChannelMember(req);
    const afterSeq = Number(req.query.afterSeq ?? 0);
    res.json((await db.getMessages(ctx.channel.id, afterSeq)).map(att.withUrls));
  }),
);

// Mark a channel read for the requester (Slack-style): advance their last_read_seq to the
// channel's max message seq, or a client-supplied `seq`. Requester + membership gated.
router.post(
  "/api/channels/:id/read",
  wrap(async (req, res) => {
    const ctx = await requireChannelMember(req);
    const rawSeq = req.body?.seq;
    const seq = rawSeq != null && Number.isFinite(Number(rawSeq)) ? Number(rawSeq) : undefined;
    const lastReadSeq = await db.markChannelRead(ctx.channel.id, ctx.me.id, seq);
    res.json({ ok: true, lastReadSeq });
  }),
);

// Durable turn chips for this channel — recent running/finished turns and still-queued
// dispatches anchored to a message here. Hydrates the trigger-message chips on channel open /
// page reload; live updates ride the app WS (agent_turn/agent_event/agent_queued).
router.get(
  "/api/channels/:id/turn-chips",
  wrap(async (req, res) => {
    const ctx = await requireChannelMember(req);
    const [turns, queued] = await Promise.all([
      db.channelTurnChips(ctx.channel.id),
      db.channelQueuedChips(ctx.channel.id),
    ]);
    res.json({ turns, queued });
  }),
);

router.get(
  "/api/channels/:id/members",
  wrap(async (req, res) => {
    const ctx = await requireChannelMember(req);
    res.json(await db.channelMembers(ctx.channel.id));
  }),
);

// Membership changes: logic in services/directory.ts (shared with the /mcp server).
router.post(
  "/api/channels/:id/members",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    const target = await directory.addChannelMemberAs(me, String(req.params.id), String(req.body?.handle ?? ""));
    res.status(201).json(target);
  }),
);

router.delete(
  "/api/channels/:id/members/:participantId",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    await directory.removeChannelMemberAs(me, String(req.params.id), String(req.params.participantId));
    res.json({ ok: true });
  }),
);

router.delete(
  "/api/channels/:id",
  wrap(async (req, res) => {
    const ctx = await requireChannelMember(req);
    if (ctx.channel.kind === "dm") throw new ApiError(400, "DMs cannot be deleted");
    // Fan out to members before deleting (afterwards there are no members to resolve).
    await fanOut(ctx.channel.id, { type: "channel_deleted", channelId: ctx.channel.id });
    await db.deleteChannel(ctx.channel.id);
    res.json({ ok: true });
  }),
);

export default router;
