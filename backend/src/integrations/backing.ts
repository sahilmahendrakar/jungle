import * as db from "../db";
import { ApiError } from "../http/errors";
import type { ResolveConfigCtx } from "./types";

// WHOSE connected account an integration attach binds to.
//
// Connection-based integrations bind an agent to one specific account: a connection row
// (config.connectionId — notion, linear, granola, x, drive, calendar) or a participant's Google
// identity (config.backingParticipantId — gmail). Every adapter resolved that account against
// `ctx.me`: the connection must belong to you, or "connect your X account in Settings first".
//
// That holds when a human attaches in Settings. It cannot hold when the actor is an AGENT — an
// attach through the agent API (mcp/tools.ts attach_integration / create_agent, or REST with an
// agent-bound token). An agent has no Settings page and never holds a connection, so the lookup was
// guaranteed to fail: an agent asked to set up a Notion workspace could never attach Notion, no
// matter how many times its owner connected or reconnected.
//
// So for an agent actor we resolve the account of the human it is acting for, in this order:
//   1. An explicit connection (`connectionId`, from the picker or an earlier binding) — must belong
//      to a person in the agent's workspace.
//   2. `onBehalfOf` — a person named by the caller.
//   3. The acting agent's OWN binding for the same integration: a human already sanctioned that
//      account for this agent, so reusing it for an agent it builds grants nothing new.
//   4. The agent's owner — participants.created_by, walked up to the first human (an agent built by
//      an agent is still ultimately somebody's).
//   5. The one person in the workspace who has connected it.
// Ambiguity is never resolved silently: two candidates produce an error naming them and how to
// choose. Bindings stay workspace-scoped and are visible on the agent's profile and in the
// Connections panel, where any member can detach them.

// Rule 4: the human an agent ultimately belongs to. created_by can point at another agent (an agent
// that creates agents), so walk up; `seen` guards a cycle from a bad backfill.
export async function ownerOf(agent: db.Participant): Promise<db.Participant | null> {
  const seen = new Set<string>([agent.id]);
  let at: db.Participant | null = agent;
  while (at?.created_by && !seen.has(at.created_by)) {
    seen.add(at.created_by);
    at = await db.getParticipant(at.created_by);
    if (at && at.kind !== "agent") return at.workspace_id === agent.workspace_id ? at : null;
  }
  return null;
}

// Humans in the actor's workspace, newest last (db.listParticipants order).
const peopleIn = async (workspaceId: string): Promise<db.Participant[]> =>
  (await db.listParticipants(workspaceId)).filter((p) => p.kind !== "agent");

const label = (c: db.IntegrationConnectionRow): string => c.external_account ?? "an unnamed account";

// "@sahil (Notion · Acme), @suhaas (Notion · Side project)" — the choices in an ambiguity error.
const listChoices = (found: Array<{ person: db.Participant; conn: db.IntegrationConnectionRow }>): string =>
  found.map(({ person, conn }) => `@${person.handle} (${label(conn)})`).join(", ");

// Resolve the connection row to bind, for the integrations keyed by connection id. `requestedId` is
// the caller's explicit choice (rawConfig.connectionId) or the existing binding on a reconfigure.
export async function resolveConnection(
  ctx: ResolveConfigCtx,
  opts: { key: string; displayName: string; requestedId: string | null },
): Promise<db.IntegrationConnectionRow> {
  const { key, displayName, requestedId } = opts;
  const isAgent = ctx.me.kind === "agent";

  // 1. An explicit connection id. A human may only name their own; an agent may name any belonging
  // to a person in its workspace (and must match onBehalfOf when that was given too).
  if (requestedId) {
    const conn = await db.getIntegrationConnectionById(requestedId);
    if (!conn || conn.integration_key !== key) {
      throw new ApiError(400, `that ${displayName} connection doesn't belong to you`);
    }
    if (!isAgent) {
      if (conn.participant_id !== ctx.me.id) {
        throw new ApiError(400, `that ${displayName} connection doesn't belong to you`);
      }
      return conn;
    }
    const owner = await db.getParticipant(conn.participant_id);
    const eligible = owner && owner.kind !== "agent" && owner.workspace_id === ctx.me.workspace_id;
    if (!eligible || (ctx.onBehalfOf && owner.id !== ctx.onBehalfOf.id)) {
      throw new ApiError(400, `that ${displayName} connection isn't available in this workspace`);
    }
    return conn;
  }

  // A human binds their own account — unchanged behaviour, including the picker's error when they
  // hold several.
  if (!isAgent) {
    if (ctx.onBehalfOf && ctx.onBehalfOf.id !== ctx.me.id) {
      throw new ApiError(403, "you can only attach your own connected accounts");
    }
    const mine = await db.listIntegrationConnectionsForKey(ctx.me.id, key);
    if (mine.length === 0) throw new ApiError(400, `connect your ${displayName} account in Settings first`);
    if (mine.length > 1) throw new ApiError(400, `choose which ${displayName} account this agent should use`);
    return mine[0];
  }

  // 2. A person named explicitly.
  if (ctx.onBehalfOf) {
    const named = ctx.onBehalfOf;
    if (named.kind === "agent" || named.workspace_id !== ctx.me.workspace_id) {
      throw new ApiError(400, `@${named.handle} is not a person in this workspace`);
    }
    const theirs = await db.listIntegrationConnectionsForKey(named.id, key);
    if (!theirs.length) {
      throw new ApiError(
        400,
        `@${named.handle} hasn't connected ${displayName} — ask them to connect it in ` +
          `Settings → Connections, then attach it again`,
      );
    }
    if (theirs.length > 1) {
      throw new ApiError(
        400,
        `@${named.handle} has several ${displayName} accounts (${theirs.map(label).join(", ")}) — say which ` +
          `by passing connectionId in the config (list_connections shows the ids)`,
      );
    }
    return theirs[0];
  }

  // 3. What the acting agent itself is bound to for this integration.
  const own = await db.getAgentIntegration(ctx.me.id, key);
  const ownId = typeof own?.config?.connectionId === "string" ? own.config.connectionId : null;
  if (ownId) {
    const conn = await db.getIntegrationConnectionById(ownId);
    if (conn && conn.integration_key === key) return conn;
  }

  // 4. The agent's owner, if they have exactly one.
  const owner = ctx.me.kind === "agent" ? await ownerOf(ctx.me) : null;
  if (owner) {
    const theirs = await db.listIntegrationConnectionsForKey(owner.id, key);
    if (theirs.length === 1) {
      console.log(`@${ctx.me.handle} attached ${key} to agent ${ctx.agentId} using @${owner.handle}'s connection`);
      return theirs[0];
    }
    if (theirs.length > 1) {
      throw new ApiError(
        400,
        `@${owner.handle} has several ${displayName} accounts (${theirs.map(label).join(", ")}) — say which ` +
          `by passing connectionId in the config (list_connections shows the ids)`,
      );
    }
  }

  // 5. The workspace's only connected person.
  const found: Array<{ person: db.Participant; conn: db.IntegrationConnectionRow }> = [];
  for (const person of await peopleIn(ctx.me.workspace_id)) {
    for (const conn of await db.listIntegrationConnectionsForKey(person.id, key)) found.push({ person, conn });
  }
  if (found.length === 1) {
    console.log(
      `@${ctx.me.handle} attached ${key} to agent ${ctx.agentId} using @${found[0].person.handle}'s connection`,
    );
    return found[0].conn;
  }
  if (!found.length) {
    throw new ApiError(
      400,
      `nobody in this workspace has connected ${displayName} yet. An agent can't hold the ` +
        `connection itself — a person has to connect ${displayName} in Settings → Connections, ` +
        `and then this attach will bind to their account.`,
    );
  }
  throw new ApiError(
    400,
    `several ${displayName} accounts are connected here (${listChoices(found)}) — say which the agent ` +
      `should use by passing onBehalfOf "@handle", or connectionId for a specific one ` +
      `(list_connections shows the ids)`,
  );
}

// The participant-keyed variant, for gmail: its account is a participant's Google identity
// (google_identities) rather than a connection row, so the same rules resolve a PERSON. `lookup`
// returns that person's identity (null = not connected) and is handed back so the caller can store
// the account label without a second read.
export async function resolveBackingParticipant<T>(
  ctx: ResolveConfigCtx,
  opts: { displayName: string; lookup: (participantId: string) => Promise<T | null> },
): Promise<{ participantId: string; connection: T }> {
  const { displayName, lookup } = opts;

  if (ctx.me.kind !== "agent") {
    if (ctx.onBehalfOf && ctx.onBehalfOf.id !== ctx.me.id) {
      throw new ApiError(403, "you can only attach your own connected accounts");
    }
    const connection = await lookup(ctx.me.id);
    if (!connection) throw new ApiError(400, `connect your ${displayName} account in Settings first`);
    return { participantId: ctx.me.id, connection };
  }

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

  const owner = await ownerOf(ctx.me);
  if (owner) {
    const connection = await lookup(owner.id);
    if (connection) return { participantId: owner.id, connection };
  }

  const connected: Array<{ person: db.Participant; connection: T }> = [];
  for (const person of await peopleIn(ctx.me.workspace_id)) {
    const connection = await lookup(person.id);
    if (connection) connected.push({ person, connection });
  }
  if (connected.length === 1) {
    const [only] = connected;
    console.log(`@${ctx.me.handle} attached ${displayName} to agent ${ctx.agentId} as @${only.person.handle}`);
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
      `should use by passing onBehalfOf, e.g. onBehalfOf: "${handles.split(", ")[0]}"`,
  );
}
