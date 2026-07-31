import * as db from "../db";

// Who an agent belongs to — the single definition, shared by every subsystem that needs it.
//
// Three things key off ownership, and before migrations/046 all three answered it differently:
//   * which Claude subscription token pays for a turn (db/participants getClaudeOauthTokenForAgent)
//   * which account's daily spend cap a turn counts against (db/usage, db/spendLimits)
//   * whose connected accounts back the agent's integrations (integrations/backing)
// The last one walked created_by up to the first human and was right; the other two took a single
// hop and silently fell back to the org API key the moment an AGENT created an agent. Having one
// resolver here is the point of the change: a fourth consumer can't invent a fifth rule.
//
// The stored answer is participants.owner_id, maintained as an invariant (a human in the agent's
// own workspace, or null). The chain walk below is only for ASSIGNING it — at create time, and as
// a self-heal for rows that predate 046 or lost their owner.

const MAX_CHAIN_DEPTH = 16;

// Walk created_by up to the first human in the agent's workspace. `seen` guards a cycle from a bad
// backfill; the depth bound guards a chain long enough to be pathological either way. Returns null
// when the chain runs out, leaves the workspace, or loops — all of which mean "no owner", which
// callers degrade to the org API key rather than treating as an error.
async function walkCreatedBy(agent: db.Participant): Promise<db.Participant | null> {
  const seen = new Set<string>([agent.id]);
  let at: db.Participant | null = agent;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    const next = at?.created_by;
    if (!next || seen.has(next)) return null;
    seen.add(next);
    at = await db.getParticipant(next);
    if (!at) return null;
    if (at.kind !== "agent") return at.workspace_id === agent.workspace_id ? at : null;
  }
  return null;
}

// Is this participant eligible to own agents in `workspaceId`? The invariant 046 documents but
// Postgres can't enforce: a human, in the same workspace. Checked on every assignment so a bad
// owner_id can't be written in the first place.
export function canOwn(p: db.Participant | null, workspaceId: string): boolean {
  return !!p && p.kind !== "agent" && p.workspace_id === workspaceId;
}

// The human an agent belongs to, or null. Prefers the stored owner_id and falls back to walking
// created_by — so an agent created before 046, or one whose owner_id was cleared by an owner's
// deletion, still resolves while the backfill/self-heal catches up. A stored owner that has since
// become ineligible (left the workspace) is ignored rather than trusted.
export async function ownerOf(agent: db.Participant): Promise<db.Participant | null> {
  if (agent.kind !== "agent") return null;
  if (agent.owner_id) {
    const stored = await db.getParticipant(agent.owner_id);
    if (canOwn(stored, agent.workspace_id)) return stored;
  }
  return walkCreatedBy(agent);
}

export async function ownerIdOf(agent: db.Participant): Promise<string | null> {
  return (await ownerOf(agent))?.id ?? null;
}

// The owner to assign to an agent that `actor` is creating. A human owns what they make; an AGENT
// passes its OWN owner down, which is the whole fix — @jungle creating an agent assigns the human
// behind @jungle, so the new agent runs on that person's subscription instead of the org key.
// Null when the actor is an ownerless agent: the agent still gets created, it just bills the org
// key, which is strictly better than refusing to create it.
export async function ownerForNewAgent(actor: db.Participant, workspaceId: string): Promise<string | null> {
  if (actor.kind !== "agent") return canOwn(actor, workspaceId) ? actor.id : null;
  const owner = await ownerOf(actor);
  return canOwn(owner, workspaceId) ? owner!.id : null;
}

// Boot sweep: give an owner to every agent that has none or whose owner is no longer eligible —
// rows predating migrations/046, and agents orphaned when their owner was deleted or left the
// workspace (the FK sets owner_id null rather than cascading, so the agent survives).
//
// Resolution order matters. The created_by chain first, because that recovers the agent's ACTUAL
// owner where the provenance is intact. Only when that yields nothing do we fall back to the
// workspace's admin — a guess, but the same guess migration 040 and the old IS NULL fallbacks made,
// so an agent's spend account doesn't move just because this sweep ran.
//
// Best-effort: an orphan that can't be resolved (nobody human left in the workspace) keeps a null
// owner and bills the org key, which is the documented degradation, not an error.
export async function healOwnerlessAgents(workspaceId: string): Promise<number> {
  const orphans = await db.listAgentsNeedingOwner(workspaceId);
  let healed = 0;
  for (const agent of orphans) {
    try {
      const viaChain = await walkCreatedBy(agent);
      const owner = canOwn(viaChain, workspaceId)
        ? viaChain
        : await db.findWorkspaceOwnerFallback(workspaceId);
      if (!canOwn(owner, workspaceId)) continue;
      if (await db.setAgentOwner(agent.id, owner!.id)) {
        healed++;
        console.log(`ownership: @${agent.handle} adopted by @${owner!.handle}`);
      }
    } catch (e) {
      console.error(`ownership: heal failed for agent ${agent.id}:`, e);
    }
  }
  return healed;
}
