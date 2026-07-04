import { randomBytes } from "node:crypto";
import * as db from "../db";
import { fanOut } from "../ws/appSocket";
import { ApiError } from "../http/errors";

// Tool confirmations: a tool call awaiting a human's allow/deny. Kept in memory (single backend);
// the WS card the human clicks resolves the promise the runner's confirm_request is awaiting.

// A decision can carry updatedInput (SDK canUseTool "allow with edited input").
export type ConfirmDecision = { result: "allow" | "deny"; denyMessage?: string; updatedInput?: unknown };

interface PendingConfirm {
  channelId: string;
  agentId: string;
  resolve: (d: ConfirmDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingConfirms = new Map<string, PendingConfirm>();
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000; // auto-deny if nobody answers, so the turn can't wedge

// Surface a tool-confirmation card into a channel and return a promise that resolves when a human
// decides (via resolveConfirmDecision) or the timeout auto-denies.
export function surfaceConfirmCard(
  agent: { id: string; handle: string; display_name: string },
  channelId: string,
  tool: string,
  input: unknown,
): Promise<ConfirmDecision> {
  const confirmId = randomBytes(9).toString("hex");
  return new Promise<ConfirmDecision>((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingConfirms.has(confirmId)) return;
      pendingConfirms.delete(confirmId);
      void fanOut(channelId, { type: "tool_confirmation_resolved", confirmId, channelId, result: "deny" });
      resolve({ result: "deny", denyMessage: "No human responded in time; the action was skipped." });
    }, CONFIRM_TIMEOUT_MS);
    pendingConfirms.set(confirmId, { channelId, agentId: agent.id, resolve, timer });
    void fanOut(channelId, {
      type: "tool_confirmation_request",
      confirmId,
      channelId,
      agentId: agent.id,
      agentHandle: agent.handle,
      agentName: agent.display_name,
      tool,
      input,
    });
  });
}

// Resolve a pending confirmation from a human's decision (POST /api/agents/confirm): fulfil the
// promise the runner is awaiting and fan out the resolution. Throws 404 if unknown/already
// resolved, 403 if the decider isn't a member of the confirm's channel.
export async function resolveConfirmDecision(
  confirmId: string,
  decision: "allow" | "deny",
  me: { id: string; handle: string },
): Promise<void> {
  const pending = pendingConfirms.get(confirmId);
  if (!pending) throw new ApiError(404, "confirmation not found or already resolved");
  if (!(await db.isMember(pending.channelId, me.id))) {
    throw new ApiError(403, "not a member of this channel");
  }
  clearTimeout(pending.timer);
  pendingConfirms.delete(confirmId);
  pending.resolve(
    decision === "allow"
      ? { result: "allow" }
      : { result: "deny", denyMessage: `Denied by @${me.handle}.` },
  );
  await fanOut(pending.channelId, {
    type: "tool_confirmation_resolved",
    confirmId,
    channelId: pending.channelId,
    result: decision,
    by: me.handle,
  });
}
