import type { ConfigureFrame, GmailIntegrationConfig } from "@jungle/shared";
import * as db from "../db";
import * as google from "../google";
import { ApiError } from "../http/errors";
import type { IntegrationAdapter } from "./types";

// Gmail integration: the agent can read/search/send/label a connected ("creator") mailbox via the
// runner's in-process gmail_* MCP tools. Connection-based — the config stores no secrets, only
// which participant's connected Google account backs it and whether writes need a human's approval.
// OAuth tokens live in google_identities (per participant); we mint a fresh ~1h access token per
// drain and hand it to the runner.

function parseGmailConfig(config: Record<string, unknown>): GmailIntegrationConfig | null {
  const c = config as Partial<GmailIntegrationConfig>;
  if (typeof c.backingParticipantId !== "string" || typeof c.email !== "string") return null;
  return {
    backingParticipantId: c.backingParticipantId,
    email: c.email,
    requireSendApproval: c.requireSendApproval !== false, // default on
  };
}

function promptBlock(gmail: GmailIntegrationConfig): string {
  return (
    `\n\n— Gmail: ${gmail.email} —\n` +
    `You can act on this mailbox with the gmail_* tools: gmail_search (find messages by query), ` +
    `gmail_read_message (read one in full), gmail_send (send a new email), gmail_create_draft ` +
    `(save a draft), gmail_modify_labels (archive / mark read / label). Searching and reading are ` +
    `always available; ` +
    (gmail.requireSendApproval
      ? `sending and modifying require a human's approval, so you'll hit a confirmation prompt — ` +
        `tell the user when you're waiting on one. `
      : `sending and modifying run without a separate approval, so be careful. `) +
    `Only touch this mailbox when you're actually asked to; never email people or change the ` +
    `inbox as an incidental side effect.`
  );
}

export const gmailAdapter: IntegrationAdapter = {
  key: "gmail",

  // A fresh attach binds to the requester's connected Google account (the "creator mailbox") —
  // 400 if they haven't connected Google yet; a reconfigure (e.g. toggling approval) keeps the
  // original mailbox binding rather than silently rebinding to whoever edited it.
  async resolveConfig(ctx, rawConfig): Promise<Record<string, unknown>> {
    const requireSendApproval =
      rawConfig.requireSendApproval !== false && rawConfig.requireSendApproval !== "false"; // default on
    const existing = ctx.existing ? parseGmailConfig(ctx.existing) : null;
    if (existing) {
      return { backingParticipantId: existing.backingParticipantId, email: existing.email, requireSendApproval };
    }
    const id = await db.getGoogleIdentity(ctx.me.id);
    if (!id) throw new ApiError(400, "connect your Google account in Settings first");
    return { backingParticipantId: ctx.me.id, email: id.email, requireSendApproval };
  },

  // Mint the Gmail token up front so the prompt only advertises Gmail when it's actually usable
  // (e.g. not when the backing user disconnected Google) — otherwise the agent would see gmail_*
  // instructions with no tools behind them.
  async buildGrant(frame: ConfigureFrame, agent, config): Promise<string | null> {
    const gmail = parseGmailConfig(config);
    if (!gmail || !google.isConfigured()) return null;
    try {
      const accessToken = await google.getValidGmailToken(gmail.backingParticipantId);
      frame.gmail = { accessToken, email: gmail.email, requireSendApproval: gmail.requireSendApproval };
      return promptBlock(gmail);
    } catch (e) {
      console.error(`runner[${agent.id}] configure: could not mint gmail token:`, e);
      return null;
    }
  },

  async refreshCredentials(agent, config, send): Promise<void> {
    const gmail = parseGmailConfig(config);
    if (!gmail || !google.isConfigured()) return;
    try {
      const accessToken = await google.getValidGmailToken(gmail.backingParticipantId);
      send({ type: "gmail_credentials", accessToken });
    } catch (e) {
      console.error(`runner[${agent.id}] could not refresh gmail token:`, e);
    }
  },
};
