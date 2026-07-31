import * as db from "../db";
import { storage } from "../storage";
import { fanOut } from "../ws/appSocket";
import * as slack from "../slack/api";

// Message deletion: the one path that removes a message, wherever the request came from (a human
// hitting DELETE /api/messages/:id, or a delete performed over in a mirrored Slack channel).
// Authorization is the caller's job — this module is the mechanism, not the policy.

// Delete our mirrored copy of a message from Slack. Only messages WE posted (origin 'jungle')
// can go: those are bot posts, and chat.delete with the bot token owns them. A message that came
// FROM Slack is owned by the Slack user who wrote it — the bot can't delete it, and shouldn't
// (deleting in Jungle is not authority to delete someone's message in their own workspace).
// Best-effort: a failure here leaves a stray line in Slack, which must not fail the delete.
async function mirrorDeleteToSlack(messageId: string): Promise<void> {
  try {
    const link = await db.getMessageLinkByJungleId(messageId);
    if (!link || link.origin !== "jungle") return;
    // Resolve the install that OWNS this channel link, not just "the team's install": a
    // workspace can have both the mirror app and the agent app, and the wrong bot's token
    // can't delete the other bot's post. Same join the outbox drain does (db/slack.ts).
    const channelLink = await db.getLinkBySlackChannel(link.slack_team_id, link.slack_channel_id);
    if (!channelLink) return;
    const install = await db.getSlackInstallByWorkspace(
      channelLink.workspace_id,
      channelLink.install_kind,
    );
    if (!install || install.status !== "active") return;
    await slack.chatDelete(install.bot_token, link.slack_channel_id, link.slack_ts);
    // Drop the mapping: the Slack side is gone, and a stale ts would misroute a later thread
    // reply that tried to hang off it.
    await db.deleteMessageLink(messageId);
  } catch (e) {
    console.warn(`slack mirror-delete failed for message ${messageId}:`, (e as Error).message);
  }
}

// Soft-delete a message, tell every client in the channel, and clean up what the row pointed at.
// Returns false when the message didn't exist. Idempotent: deleting an already-deleted message
// is a no-op that still reports success (a double-click, or our own Slack mirror-delete arriving
// back as a message_deleted event).
export async function deleteMessage(
  messageId: string,
  actorId: string | null,
  opts: { mirrorToSlack?: boolean } = {},
): Promise<boolean> {
  const result = await db.softDeleteMessage(messageId, actorId);
  if (!result) return false;
  if (result.alreadyDeleted) return true;

  await fanOut(result.channelId, {
    type: "message_deleted",
    channelId: result.channelId,
    messageId,
    threadRootId: result.threadRootId,
    tombstone: result.tombstone,
  });

  // Blobs go after the txn commits — deleting a file isn't transactional, and the attachment GC
  // sweeps anything that fails here anyway (rows are already gone).
  for (const key of result.storageKeys) {
    await storage.delete(key).catch((e) => console.warn(`attachment blob delete failed:`, e));
  }
  if (opts.mirrorToSlack !== false) await mirrorDeleteToSlack(messageId);
  return true;
}
