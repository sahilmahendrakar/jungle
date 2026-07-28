import * as db from "../db";
import { ApiError } from "../http/errors";
import type { ResolveConfigCtx } from "./types";

// Which participant's connected account backs an integration attach.
//
// Every connection-based integration (gmail, notion, linear, …) binds an agent to exactly ONE
// human's OAuth grant, stored as `backingParticipantId` in the agent_integrations config. When a
// human attaches from Settings that's simply them, and every adapter used to hardcode that:
// `getConnection(ctx.me.id)` or 400 "connect your X account in Settings first".
//
// But attaches also arrive from the agent API (mcp/tools.ts attach_integration / create_agent, or
// any REST call with an agent-bound token), where `ctx.me` is an AGENT. An agent has no Settings
// page and can never hold a connection of its own, so binding to `ctx.me` there always failed with
// "connect your X account in Settings first" — advice the human had usually already followed,
// which made the error a dead end (an agent asked to set up a Notion workspace could never attach
// Notion, no matter how many times its owner reconnected).
//
// So for an agent actor we resolve the human it is acting for instead, in this order:
//   1. `onBehalfOf` — a person named explicitly by the caller (must be in the workspace and
//      actually connected). Always wins; this is the escape hatch when 3 is ambiguous.
//   2. The acting agent's OWN binding for the same integration, if it has one — a human already
//      sanctioned that grant for this agent, so propagating it to an agent it builds adds no
//      access that the actor didn't already have.
//   3. The one person in the workspace who has connected that integration. Exactly one → use them;
//      zero or several → a specific error (nobody to bind / name one with onBehalfOf) rather than
//      silently picking.
// The binding is always workspace-scoped, and it's visible afterwards on the agent's profile and
// in the Connections panel, where any member can detach it.
export async function resolveBacking<T>(
  ctx: ResolveConfigCtx,
  opts: {
    key: string; // catalog key — used to find the acting agent's own binding (rule 2)
    displayName: string; // "Notion" — for the user-facing errors
    // The connection this integration is built on, for one participant (null = not connected).
    // Returned to the caller so adapters can store the account label without a second read.
    lookup: (participantId: string) => Promise<T | null>;
  },
): Promise<{ participantId: string; connection: T }> {
  const { key, displayName, lookup } = opts;

  // A human attaches their own account, full stop — naming someone else would be borrowing their
  // credentials.
  if (ctx.me.kind !== "agent") {
    if (ctx.onBehalfOf && ctx.onBehalfOf.id !== ctx.me.id) {
      throw new ApiError(403, "you can only attach your own connected accounts");
    }
    const connection = await lookup(ctx.me.id);
    if (!connection) throw new ApiError(400, `connect your ${displayName} account in Settings first`);
    return { participantId: ctx.me.id, connection };
  }

  // 1. Explicitly named person.
  const named = ctx.onBehalfOf;
  if (named) {
    if (named.kind === "agent" || named.workspace_id !== ctx.me.workspace_id) {
      throw new ApiError(400, `@${named.handle} is not a person in this workspace`);
    }
    const connection = await lookup(named.id);
    if (!connection) {
      throw new ApiError(
        400,
        `@${named.handle} hasn't connected ${displayName} — ask them to connect it in ` +
          `Settings → Connections, then attach it again`,
      );
    }
    return { participantId: named.id, connection };
  }

  // 2. The acting agent's own binding for this integration.
  const own = await db.getAgentIntegration(ctx.me.id, key);
  const ownBacking = typeof own?.config?.backingParticipantId === "string" ? own.config.backingParticipantId : null;
  if (ownBacking) {
    const connection = await lookup(ownBacking);
    if (connection) return { participantId: ownBacking, connection };
  }

  // 3. The workspace's only connected person.
  const humans = (await db.listParticipants(ctx.me.workspace_id)).filter((p) => p.kind !== "agent");
  const connected: Array<{ person: db.Participant; connection: T }> = [];
  for (const person of humans) {
    const connection = await lookup(person.id);
    if (connection) connected.push({ person, connection });
  }
  if (connected.length === 1) {
    const [only] = connected;
    console.log(`@${ctx.me.handle} attached ${key} to agent ${ctx.agentId} backed by @${only.person.handle}`);
    return { participantId: only.person.id, connection: only.connection };
  }
  if (!connected.length) {
    throw new ApiError(
      400,
      `nobody in this workspace has connected ${displayName} yet. An agent can't hold the ` +
        `connection itself — a person has to connect ${displayName} in Settings → Connections, ` +
        `and then this attach will bind to their account.`,
    );
  }
  const handles = connected.map((c) => `@${c.person.handle}`).join(", ");
  throw new ApiError(
    400,
    `several people have connected ${displayName} (${handles}) — say whose account the agent ` +
      `should act as by passing onBehalfOf, e.g. onBehalfOf: "${handles.split(", ")[0]}"`,
  );
}
