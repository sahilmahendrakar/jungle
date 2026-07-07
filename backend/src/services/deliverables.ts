import { extractDeliverableLinks } from "@jungle/shared";
import * as db from "../db";
import type { PersistedMessage } from "../db";
import { fanOut } from "../ws/appSocket";

// Deliverables capture: when an agent's message lands, pull out the recognizable work-artifact
// links (PRs, docs, issues, … — classification lives in shared/src/deliverables.ts so the
// frontend's inline cards agree with what gets recorded) and persist the new ones. Fired
// fire-and-forget from the orchestrator's send path; failures log and never block the message.

export async function recordDeliverables(
  agent: { id: string; workspace_id: string },
  channelId: string,
  message: PersistedMessage,
): Promise<void> {
  try {
    const links = extractDeliverableLinks(message.body);
    if (!links.length) return;
    const created = await db.insertDeliverables(
      links.map((l) => ({
        workspaceId: agent.workspace_id,
        agentId: agent.id,
        channelId,
        messageId: message.id,
        kind: l.kind,
        title: l.title,
        url: l.url,
      })),
    );
    // Fan out to the channel's members (not the whole workspace — a DM's deliverable is private
    // to its two members, same scoping as the feed query).
    for (const d of created) {
      await fanOut(channelId, { type: "deliverable_created", deliverable: d });
    }
  } catch (e) {
    console.error("recordDeliverables:", e);
  }
}
