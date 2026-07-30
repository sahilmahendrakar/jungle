# Plan: `@jungle` default agent

Status: implemented. See "What was built" at the bottom for how the shipped code differs from this plan.

## What we're building

A single, locked, default agent per workspace with handle `@jungle`:

- Auto-created for every workspace — new workspaces at creation time, existing workspaces via a one-time backfill.
- Cannot be renamed or deleted by workspace members (system-owned, like the existing Architect/Liana-conductor agents, but with no member-facing off switch).
- Ships with the `jungle-admin`, Notion and Granola integrations attached automatically wherever a resolvable connection exists in the workspace; unresolved integrations are skipped at creation, not blocking.
- Positioned as the workspace's general-purpose "gateway" agent: answer anything, and on request build things (e.g. a Notion CRM) plus the automations around them (e.g. a schedule that reminds the user after N days of lead silence), deciding case by case whether to do the work inline or spin up a dedicated agent/workflow for it.

## Decisions made (via user Q&A, 2026-07-29)

| Question | Decision |
|---|---|
| Default integration set | Notion + Granola, **plus `jungle-admin`** (see below) — not "all connected", not the full catalog |
| Behavior with zero/partial connections at creation | Create Jungle immediately; skip integrations that can't resolve to a user connection; attach later once resolvable |
| Lifecycle | Exactly one per workspace, auto-created (new + backfilled), locked — no rename/delete |
| How Jungle executes requests | Its call — simple asks handled inline with its own tools, more involved/ongoing responsibilities may become a dedicated agent or workflow, per its own judgment (encoded in its persona, not hardcoded branching) |

## Confirmed already in place (no new build needed)

- **Automations/workflows**: `schedules` (cron/one-shot) and `workflows` (roster + trigger + prose playbook + runs) already exist and are already creatable by any agent via MCP tools (`schedule_create`, `schedule_list`, `schedule_cancel`, workflow-builder tools). Jungle uses these as-is.
- **Granola**: already a live, read-only remote-MCP OAuth integration (`shared/src/integrations.ts:143-151`, adapter in `backend/src/integrations/providers.ts:40-51`). Nothing to build here.
- Fetched `origin/main` — no prior "Jungle agent" work exists upstream to build on or conflict with.

## How this maps onto the existing codebase

Agents are `participants` rows (`kind='agent'`) — there's no separate `agents` table. Two existing "default agent" precedents to follow:

- **Architect**: one per workspace, lazily find-or-created the first time the workflow builder is opened (`backend/src/services/workflows.ts:754 ensureArchitect`), identified by a fixed handle.
- **Liana conductor**: one per user, lazily created on first use (`backend/src/services/liana.ts:129 ensureLianaAgent`), flagged via a dedicated boolean column on `participants` (`liana_conductor`, added in `migrations/037`/`038`) that changes its runtime behavior (idle-suspend, compaction).

Plan for Jungle, following the same conventions:

1. **Marker column**: add `is_jungle_default` (or similar) boolean on `participants`, mirroring the `liana_conductor` pattern. Used to (a) identify the agent, (b) block delete/rename in `backend/src/http/routes/agents.ts` + `backend/src/services/agentAdmin.ts`, (c) exempt it from the workspace's `max_agents` cap in `backend/src/db/workspaces.ts:agentCountAndCap`.
2. **Creation helper**: `ensureJungleAgent(workspaceId)` — find-or-create by the marker column (not by handle alone, so a rename attempt can't create a duplicate).
3. **Hook points**: call `ensureJungleAgent` at the end of `createWorkspaceWithCreator` (`backend/src/db/workspaces.ts:24`, used by `backend/src/http/routes/workspaces.ts:45,144` and `backend/src/services/liana.ts:324,490`), plus a one-time backfill script/migration for existing workspaces.
4. **Reserved handle**: block `jungle` from being claimed by any other participant in a workspace (handle uniqueness check, currently unconditional in the participant-insert path).
5. **Integration attach — needs a behavior change**: `createAgentAs` (`backend/src/services/agentAdmin.ts`) currently attaches integrations all-or-nothing, rolling back the whole agent if one can't resolve to a connection (via `backend/src/integrations/backing.ts:resolveConnection`). For Jungle we need per-integration try/skip instead of all-or-nothing, since a brand-new workspace will have zero connections at creation time.
6. **Later attach**: when a user creates their first `integration_connections` row for notion/granola in a workspace, check whether that workspace's Jungle agent is missing the corresponding attachment and attach it then. (No existing hook for "connection created" event — this is new wiring, in `backend/src/db/connections.ts` or wherever connections are inserted.)
7. **Persona**: new system prompt in the style of `ARCHITECT_PERSONA`, describing Jungle as the general-purpose entry point — capable of everyday conversation, using its Notion/Granola tools directly, and creating schedules/workflows for automation requests, choosing inline execution vs. delegating to a new agent/workflow based on the complexity/durability of the ask.

## Known risks / things worth flagging

1. **Connections are per-user, not per-workspace.** Whichever workspace member happens to connect Notion/Granola first becomes the account Jungle's tool calls run as (via the existing `resolveConnection` fallback: owner's connection → sole connected person in the workspace → ambiguous-candidates error). If that person disconnects or leaves, Jungle silently loses that tool — this is existing behavior for any agent, not new, but it's worth the team knowing "auto-connected" doesn't mean workspace-owned.
2. **No event/webhook-driven trigger type exists.** Schedule/workflow triggers are cron, one-shot, manual, or `@mention` only — nothing reacts to "a Notion page changed" or "a Granola meeting ended." So "remind me if I haven't spoken to a lead in N days" has to be built as a recurring schedule where Jungle's own prompt tells it to go check Notion and only speak up if the condition holds (polling), not a true push trigger. Functionally fine for this use case, just not instant/event-driven.
3. **Handle collision on backfill.** If any existing workspace already has a human/agent using the handle `jungle`, the backfill needs a defined fallback (skip that workspace and flag it, or suffix the handle) rather than silently failing.
4. **Scope creep risk**: Jungle having both broad conversational scope and `create_agent`/workflow-builder tools means its own persona/prompt is doing a lot of judgment-call work ("do this myself vs. spin up a new agent"). Worth reviewing that persona carefully once drafted, since it's the main lever controlling whether Jungle behaves predictably.

## Non-goals for this task

- No new automation/trigger engine (reuses `schedules`/`workflows` as-is).
- No new integration build-out (Granola already exists; no other integrations requested).
- No workspace-member-facing way to rename/delete/disable Jungle.
- No push/event-based trigger primitive (out of scope; polling via schedules is the accepted mechanism for now).

---

## What was built

Everything above landed roughly as planned. Where the shipped code differs, and why:

**`jungle-admin` joined the default set.** The catalog already contains a `jungle-admin` integration
(`shared/src/integrations.ts`, adapter `backend/src/integrations/jungle.ts`) that mounts Jungle's own
MCP server into an agent with an agent-bound API token — it is what lets an agent create channels,
agents, workflows and schedules at all. Without it @jungle could not build the automations that are
the entire point of the feature. It needs no external account (the backend mints the token), so
unlike notion/granola it always attaches, including in a brand-new workspace with zero connections.

**Files:**

| File | What |
|---|---|
| `backend/migrations/044_jungle_default_agent.sql`, `backend/db/schema.sql` | `participants.jungle_default` + a partial unique index enforcing one per workspace |
| `backend/src/services/jungleAgent.ts` | `ensureJungleAgent` / `syncJungleIntegrations` / `backfillJungleAgents`, the persona, and the best-effort attach |
| `backend/src/services/agentAdmin.ts` | rename/delete guards; reserved-handle check in `createAgentAs`; `RUNNER_PROVIDER_DEFAULT` exported |
| `backend/src/db/participants.ts` | `jungleDefault` on insert, `getJungleAgent`, backfill worklist, `RESERVED_HANDLES` |
| `backend/src/db/workspaces.ts` | default agent excluded from the agent cap |
| `backend/src/http/routes/workspaces.ts` | create a workspace → ensure its default agent |
| `backend/src/http/routes/integrations.ts` | OAuth connect callback → retro-attach whatever @jungle was missing |
| `backend/src/index.ts` | boot backfill for pre-existing workspaces |
| `shared/src/domain.ts`, `frontend/src/components/chat/panels.tsx` | `jungle_default` on the wire; rename disabled + delete hidden, with an explanation |
| `backend/test/jungle-default-agent.mjs` | 20 checks over the whole feature |

**Decisions taken during implementation:**

1. **Runner provider follows the deployment default**, not the hardcoded `"fly"` that `ensureArchitect`
   and `ensureLianaAgent` use. @jungle is the one agent every workspace is expected to reach; on a
   deployment that runs agents on docker, a Fly-only default agent would simply be permanently
   offline. It now uses the same `RUNNER_PROVIDER_DEFAULT` as ordinary agents.
2. **Liana workspaces are excluded from the backfill.** Liana creates a workspace per user behind the
   scenes for a separate Slack-first product; nobody there will type @jungle, and backfilling would
   provision a machine per Liana user for nothing. Detected via `liana_slack_installs` or the
   presence of a `liana_conductor` agent.
3. **The reserved-handle check moved into `createAgentAs`.** Reserving `jungle` inside
   `db.handleAvailable` alone was not enough — `createAgentAs` never called it, so an agent using the
   `create_agent` MCP tool could still take the handle in a workspace whose default agent didn't
   exist yet. The test caught this. (Side effect: duplicate agent handles now fail with a clean 409
   instead of a raw unique-index error.)
4. **The `_dev/workspaces` test route deliberately does *not* create a default agent**, to keep
   existing tenancy tests unperturbed. The boot backfill covers those workspaces anyway.

**Risk 3 from above (handle collision) is handled**: `availableHandle` falls back to
`jungle-agent`, then `jungle-agent-N`, then a random suffix. This was exercised for real — a
workspace where the handle was already taken backfilled onto `@jungle-agent` correctly.

**Risks 1, 2 and 4 stand as written** and are unchanged by the implementation. Risk 2 (no
event-driven triggers) is now stated explicitly in the persona, so @jungle tells users it can only
promise a periodic check rather than an instant alert.

**Verification**: all four packages typecheck; `backend/test/jungle-default-agent.mjs` passes 20/20;
the existing `backend/test/agent-attach-integration.mjs` suite still passes; the migration applies
cleanly and a real boot backfilled 9 workspaces. Not verified end-to-end: an actual @jungle turn
(no runner image or Fly credentials in this environment), so the persona's real-world behavior —
particularly its inline-vs-delegate judgment — is still unexercised.
