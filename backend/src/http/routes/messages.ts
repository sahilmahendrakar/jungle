import { Router } from "express";
import * as db from "../../db";
import * as messages from "../../services/messages";
import { wrap, ApiError } from "../errors";
import { requireRequester } from "../guards";

const router = Router();

// Delete a message. The rule (deliberately asymmetric):
//   * a HUMAN's message — only its author may delete it. Nobody edits or removes someone else's
//     words, admins included.
//   * an AGENT's message — any human member of the channel may delete it. An agent's output is
//     the workspace's output: whoever it lands in front of can clear it, and requiring the
//     agent's creator would leave junk sitting in channels they don't read.
// Agents themselves can't delete anything (they post through the runner protocol, and this is a
// requester-gated endpoint) — an agent must not be able to erase the record of what it did.
router.delete(
  "/api/messages/:id",
  wrap(async (req, res) => {
    const me = await requireRequester(req);
    if (me.kind !== "human") throw new ApiError(403, "agents cannot delete messages");
    const msg = await db.getDeletableMessage(String(req.params.id));
    if (!msg) throw new ApiError(404, "message not found");
    // Membership is checked before authorship so a non-member learns nothing about the message.
    if (!(await db.isMember(msg.channel_id, me.id))) {
      throw new ApiError(403, "not a member of this channel");
    }
    if (msg.sender_kind === "human" && msg.sender_id !== me.id) {
      throw new ApiError(403, "only the sender can delete their own message");
    }
    if (!(await messages.deleteMessage(msg.id, me.id))) {
      throw new ApiError(404, "message not found");
    }
    res.json({ ok: true });
  }),
);

export default router;
