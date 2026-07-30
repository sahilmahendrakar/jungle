import { randomBytes } from "node:crypto";
import { DEFAULT_AGENT_MODE } from "@jungle/shared";
import * as db from "../db";
import * as runners from "../runners";
import { provisionerFor } from "../provisioner";
import { attachIntegrationAs, RUNNER_PROVIDER_DEFAULT } from "./agentAdmin";

// @jungle — the workspace's default agent, and the front door to the product: you talk to it to
// get anything done, and it can reshape the workspace itself (channels, agents, workflows,
// schedules) through the jungle-admin integration. Exactly one per workspace, created with the
// workspace and backfilled into existing ones at boot; members can't rename or delete it (guarded
// in agentAdmin.ts) and it doesn't count against the workspace's agent cap.
//
// Follows the ensureArchitect/ensureLianaAgent convention — an ordinary runtime='sdk' participant,
// found-or-created by a marker column (participants.jungle_default, migrations/044) and provisioned
// lazily in the background.

export const JUNGLE_HANDLE = "jungle";
const JUNGLE_DISPLAY_NAME = "Jungle";

// What @jungle is born with. jungle-admin is the load-bearing one: it mounts Jungle's own MCP
// server (integrations/jungle.ts) and is what lets @jungle create workflows, schedules, channels
// and agents at all. It needs no external account — the backend mints the token — so it always
// attaches. notion + granola are connection-based and only attach once somebody in the workspace
// has connected them (see attachDefaultIntegrations).
const DEFAULT_INTEGRATIONS = ["jungle-admin", "notion", "granola"] as const;

// @jungle runs on Opus 5, and on a person's Claude subscription rather than the org API key. Both
// follow from the same thing: the agent is adopted by a subscriber (participants.created_by), whose
// token pays for its turns (db.getClaudeOauthTokenForAgent walks created_by) and whose connected
// accounts back its integrations (integrations/backing.ts rule 4 — "the agent's owner").
//
// While that's the arrangement, a workspace with no subscriber gets no @jungle at all: an Opus 5
// agent every workspace can talk to, billed to the org key, is not a bill anyone has agreed to.
// It appears as soon as someone in the workspace sets a subscription token, on the next boot sweep.
const JUNGLE_MODEL = "claude-opus-5";

const JUNGLE_PERSONA =
  `You are Jungle — this workspace's default agent and the way people get things done here. ` +
  `Anyone can reach you by saying @jungle. Be a capable generalist: answer questions, do the ` +
  `work, and set up the machinery that keeps doing it.\n` +
  `What you can reach: your Notion and Granola tools (when someone in the workspace has ` +
  `connected them), and the mcp__jungle-admin__* tools for the workspace itself — create ` +
  `channels and agents, build and run workflows, and create schedules (recurring or one-shot) ` +
  `that fire a turn on a cadence.\n` +
  `Judgement about how to do a job — this is the important part. Do it yourself, right now, in ` +
  `this conversation when the ask is a one-off: a question, a document, a change in Notion, a ` +
  `single reminder. Reach for a schedule when something has to keep happening on a cadence. ` +
  `Build a workflow or a dedicated agent only when the job is genuinely ongoing and big enough ` +
  `to deserve an owner — a recurring multi-step process, or something a person will keep coming ` +
  `back to. Don't spawn an agent for a task you could have finished in this turn; workspaces get ` +
  `cluttered fast and every extra agent is something a human has to understand later.\n` +
  `A worked example. "Build me a CRM in Notion and remind me when I haven't spoken to a lead in ` +
  `a few days": create the Notion database yourself, then create ONE recurring schedule that ` +
  `re-reads it and speaks up only when a lead has actually gone quiet. That's two tool calls and ` +
  `no new agents — not a workflow.\n` +
  `Note on triggers: nothing here is event-driven. You can't be woken by a change in Notion or a ` +
  `new Granola note; you can only check on a schedule. So "tell me when X happens" becomes a ` +
  `recurring check that stays quiet unless X is true. Say so plainly when it matters — promise a ` +
  `daily check, never an instant alert.\n` +
  `If a tool you need isn't connected, say which one and that a person has to connect it in ` +
  `Settings → Connections; you can't hold the account yourself. Keep replies short and concrete, ` +
  `and when you've built something, say where it lives and how it starts.`;

// Attach the default integrations that aren't attached yet, one at a time and best-effort.
//
// Unlike a normal create (agentAdmin.createAgentAs, which is all-or-nothing so a typo can't leave a
// half-made agent), @jungle exists whether or not its integrations resolve: a brand-new workspace
// has no connections at all, and the agent still has to be usable. So a key that can't bind is
// skipped and retried later — on the next connect (syncJungleIntegrations) or the next boot.
// The actor is @jungle itself, so integrations/backing.ts resolves the account through its owner
// (rule 4: the subscriber who adopted it). That's why the agent has an owner at all — with
// created_by null it fell through to rule 5, "the workspace's single connected person", which
// errors out the moment two people have Notion connected, so Notion silently never attached.
// If the owner holds several accounts for one integration that's still ambiguous by design: we
// skip rather than guess, and a human picks the account on the agent's page.
async function attachDefaultIntegrations(agent: db.Participant): Promise<void> {
  const attached = new Set((await db.listAgentIntegrations(agent.id)).map((row) => row.integration_key));
  for (const key of DEFAULT_INTEGRATIONS) {
    if (attached.has(key)) continue;
    try {
      await attachIntegrationAs(agent, agent.id, key, {});
    } catch (e) {
      // Expected on a fresh workspace ("nobody has connected Notion yet") — not an error.
      console.log(`@jungle: ${key} not attached yet in workspace ${agent.workspace_id}: ${(e as Error).message}`);
    }
  }
}

// "jungle", or "jungle-agent"/"jungle-agent-2"/… if a workspace already has something on that
// handle. Only reachable in an existing workspace — a new one is empty except for its creator.
async function availableHandle(workspaceId: string): Promise<string> {
  if (!(await db.getParticipantByHandle(workspaceId, JUNGLE_HANDLE))) return JUNGLE_HANDLE;
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? "jungle-agent" : `jungle-agent-${n + 1}`;
    if (!(await db.getParticipantByHandle(workspaceId, candidate))) return candidate;
  }
  return `jungle-${randomBytes(3).toString("hex")}`;
}

// Open @jungle's DM with everyone in the workspace, so it is simply THERE in each member's DM list
// — empty, but present — instead of appearing only after someone goes looking for it in the people
// directory. listChannels is membership-scoped (db/channels.ts), so a DM you've never opened isn't
// in your sidebar at all; the channel row has to exist for @jungle to be visible as the front door.
// findOrCreateDm dedupes, so this is idempotent and safe to re-run on every boot.
//
// The new channel reaches open clients on their next channel-list fetch (page load / reconnect) —
// creating a DM has never broadcast, and this doesn't add a first broadcast for it.
async function ensureJungleDms(agent: db.Participant): Promise<void> {
  const people = (await db.listParticipants(agent.workspace_id)).filter((p) => p.kind !== "agent");
  for (const person of people) {
    try {
      await db.findOrCreateDm(agent.id, person.id);
    } catch (e) {
      console.error(`@jungle: could not open a DM with @${person.handle}:`, (e as Error).message);
    }
  }
}

// One member's side of the above — for someone who joins after @jungle already exists.
export async function ensureJungleDmFor(person: db.Participant): Promise<void> {
  const agent = await db.getJungleAgent(person.workspace_id);
  if (!agent) return;
  await db.findOrCreateDm(agent.id, person.id);
}

// Find-or-create a workspace's @jungle. Safe to call repeatedly, and that's the point: on an
// existing agent it re-runs the integration sync (picking up accounts connected since) and re-opens
// member DMs (picking up people who joined since), so the boot sweep heals both.
export async function ensureJungleAgent(workspaceId: string): Promise<db.Participant | null> {
  const owner = await db.findSubscriptionOwner(workspaceId);
  const existing = await db.getJungleAgent(workspaceId);
  if (!owner) {
    // Nobody here is on a subscription. Leave an existing agent alone rather than deleting it —
    // its turns just fall back to the org key until someone sets a token again.
    if (!existing) console.log(`@jungle: no Claude subscription in workspace ${workspaceId} — skipping`);
    return existing;
  }
  if (existing) {
    // Adopt: an @jungle created before this (created_by null), or one whose owner stopped being the
    // subscriber, re-points at the current one so its turns bill correctly and its integrations
    // resolve through that person's accounts.
    if (existing.created_by !== owner.id) {
      await db.setAgentCreatedBy(existing.id, owner.id);
      existing.created_by = owner.id;
      console.log(`@jungle: adopted by @${owner.handle} in workspace ${workspaceId}`);
    }
    if (existing.model !== JUNGLE_MODEL) {
      await db.updateAgentConfig(existing.id, { model: JUNGLE_MODEL });
      existing.model = JUNGLE_MODEL;
    }
    await attachDefaultIntegrations(existing);
    await ensureJungleDms(existing);
    await runners.reconfigure(existing.id).catch(() => {});
    return existing;
  }
  const handle = await availableHandle(workspaceId);
  const runnerToken = randomBytes(32).toString("hex");
  // No agent-cap check: the default agent is part of the workspace, not something a member chose
  // to add, so it must exist even in a workspace that's already at its limit.
  const participant = await db.createParticipant({
    kind: "agent",
    workspaceId,
    handle,
    displayName: JUNGLE_DISPLAY_NAME,
    runtime: "sdk",
    runnerToken,
    model: JUNGLE_MODEL,
    mode: DEFAULT_AGENT_MODE,
    // The deployment's normal provider, not a hardcoded "fly" like the Architect: @jungle is the
    // one agent every workspace is expected to reach, so it has to run wherever ordinary agents
    // run — on a docker deployment, a Fly-only default agent would just be permanently offline.
    runnerProvider: RUNNER_PROVIDER_DEFAULT,
    persona: JUNGLE_PERSONA,
    jungleDefault: true,
    createdBy: owner.id, // the subscriber whose seat pays for it and whose accounts back it
  });
  await attachDefaultIntegrations(participant);
  await ensureJungleDms(participant);
  void (async () => {
    try {
      await provisionerFor(participant).create({ id: participant.id, handle, runnerToken });
      await provisionerFor(participant).start(participant.id);
      runners.noteProvisionerStart(participant.id);
    } catch (e) {
      console.error("provision jungle agent:", e);
    }
  })();
  return participant;
}

// A person just connected an account — give this workspace's @jungle the integrations it couldn't
// bind before. Best-effort and fire-and-forget: the OAuth callback must not fail over this.
export async function syncJungleIntegrations(workspaceId: string): Promise<void> {
  const agent = await db.getJungleAgent(workspaceId);
  if (!agent) return;
  await attachDefaultIntegrations(agent);
}

// Boot sweep: make sure every eligible workspace has its default agent, its integrations, and a DM
// open with each member. Runs over ALL eligible workspaces, not just ones missing an agent, so an
// existing @jungle heals — that's how workspaces that were wrongly skipped by the old Liana filter,
// and members who joined before this shipped, get picked up. Idempotent and best-effort; a
// workspace that fails is retried on the next boot.
export async function backfillJungleAgents(): Promise<void> {
  const workspaceIds = await db.listWorkspaceIdsForJungleAgent();
  if (!workspaceIds.length) return;
  console.log(`@jungle: reconciling the default agent across ${workspaceIds.length} workspace(s)`);
  let created = 0;
  for (const workspaceId of workspaceIds) {
    try {
      const had = await db.getJungleAgent(workspaceId);
      if (!had && (await ensureJungleAgent(workspaceId))) created++;
      else if (had) await ensureJungleAgent(workspaceId);
    } catch (e) {
      console.error(`@jungle reconcile failed for workspace ${workspaceId}:`, e);
    }
  }
  if (created) console.log(`@jungle: created the default agent in ${created} workspace(s)`);
}
