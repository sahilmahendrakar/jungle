# Workflows + IA simplification — design & build plan

_Branch: `feat/workflows` (big-bang: ships as one coherent release, preprod first). Drafted 2026-07-17 from product discussion; interactive mockups at `~/dev/jungle-mockups/workflows.html` (5 screens: Home, Workflows, Detail, Run, Builder)._

## 1. What we're building

Two things that ship together:

1. **Workflows**: a first-class object — a team of agents + a trigger + a playbook — that users create conversationally (the **Architect** builder agent) or from **templates**. Each trigger firing is a **run** with an observable timeline. Workflows compile down to primitives that already exist (agents, channels, schedules, the orchestrator cascade); they are **not** a new execution engine.
2. **IA simplification**: the sidebar collapses from Search/Agents/Approvals/Deliverables/Scheduled to **Home / Workflows / Team** + chat. Home becomes the attention-ranked inbox (approvals, stalled runs, deliverables, live activity, upcoming runs). Scheduled disappears as a surface — a schedule is a one-agent workflow. Agents home becomes Team.

### Decisions already made (with Sahil, 2026-07-17)

- **Big bang** on one branch, not incremental shipping. Preprod → prod.
- **Architect conversational builder is in v1** (not a form-first fallback). A structured settings editor still exists for post-creation edits, but creation UX = chat + live diagram.
- **Triggers v1**: schedule (cron), manual "Run now", and **channel message** (post/@mention in a watched channel starts a run). Webhook + email-arrival triggers deferred; trigger is a tagged union so they're additive.
- **All four launch templates**: Support triage / bug-fix crew, Daily standup digest, Inbound lead research, Content pipeline.
- **Soft enforcement, not a DAG**: playbook stages/handoffs are injected into agent prompts; the orchestrator *knows* the expected shape only to detect stalls and nudge — agents keep their judgment.
- **No destructive migration of schedules**: the existing schedules engine becomes the trigger substrate; the `/scheduled` UI folds into Workflows.
- **Agent supply**: default = fresh agents from role seeds, **but binding existing agents to roles is supported in v1** (`workflow_members.participant_id` can reference any workspace agent; Architect offers it when the user has agents; bound agents get the workflow prompt section added, not replaced).
- **Architect is a full runner agent** (per-workspace, standard runner infra, lazily provisioned on first builder open). DM-able afterwards for edits ("add a fourth fixer"); its `workflow_*` tools ride the same agent-tool mechanism as `schedule_*`/`service_*`.
- **Roster UX — grouped + quiet**: Team groups members under their workflow; workflow agents don't auto-appear in the DM sidebar (only after you DM one).
- **Staged preprod drops**: (1) IA + Home + gallery, (2) template runs + Run view, (3) Architect builder, (4) channel trigger + stall detection.
- **Simplicity mandate (Sahil, 2026-07-17)**: dead simple, obvious to use, few failure points. Consequences baked in below: playbook is **prose** (no stage schema, no handoff timeouts, no stage tracking); roster lives as jsonb on the workflow row (no members table); guardrails = member agents' existing mode/confirmation settings (no new schema); runs have no stats jsonb; draft protocol is whole-object set + refetch (no patches); cron trigger = one nullable `workflow_id` column on schedules (no second ticker); channel trigger = @mention the intake agent in the home channel (recorded as a run); run completion = one explicit tool + quiescence fallback; two new tables total (`workflows`, `workflow_runs`); two coarse ServerEvents (`workflow_changed`, `workflow_run_changed` — clients refetch, like `schedule_changed`).

## 2. Channel model

A workflow is **associated with channels in three distinct roles** (per discussion — association is flexible, not a forced 1:1):

- **Home channel (exactly one).** Where the team's run activity lives. Default: auto-created and named after the workflow (`#support-triage`), archived with it. Alternatively the user picks an existing channel — multiple workflows may share a home (e.g. lightweight single-agent workflows all homed in `#ops`).
- **Runs are threads.** Each run posts a run-header message in the home channel ("▶ Support triage — run started, Jul 17 8:00 AM") and all agent-to-agent conversation for that run happens in that thread. This keeps shared home channels legible and gives the Run view a 1:1 anchor (`workflow_runs.root_message_id`). Members can still be DM'd/mentioned elsewhere, but playbook prompts direct in-run collaboration to the thread.
- **Destination channels (zero or more).** Outputs — "post the digest to #eng", "DM Sahil the report" — are playbook steps, not homes. No schema needed beyond the playbook prose/goals.
- **Watched channels (zero or more).** The channel-message trigger watches a channel (mention-only or all posts); may or may not be the home.

## 3. Data model (one additive migration, two tables)

```sql
workflows(id, workspace_id, name, description, emoji,
          status CHECK IN (draft|active|paused), template_id TEXT NULL,
          home_channel_id NULL,      -- null while draft
          trigger JSONB,             -- WorkflowTrigger below
          roster JSONB,              -- WorkflowRole[] below
          playbook TEXT,             -- PROSE. The whole "how this team works" instruction.
          created_by, created_at, updated_at)   -- backing schedule found via schedules.workflow_id

workflow_runs(id, workflow_id, workspace_id,
              trigger CHECK IN (schedule|manual|channel_message),
              status CHECK IN (running|done|stalled|stopped),
              root_message_id NULL,  -- run-header message = the run's thread anchor
              summary TEXT NULL, started_at, ended_at)

ALTER TABLE schedules ADD COLUMN workflow_id NULL;  -- ticker branches to workflow dispatch; hidden from /scheduled lists
```

Run **timeline** is derived, not stored: the run's thread + member agent turns whose dispatch context carries `workflowRunId` (`agent_inbox.context` is already jsonb — no migration). No run-events table, no stats.

**Templates are code, not DB**: a module in `@jungle/shared` (id, name, emoji, description, roster seeds, playbook prose, default trigger).

### Wire types (in `@jungle/shared`)

```ts
type WorkflowTrigger =
  | { type: 'schedule'; cron: string; timezone: string }  // reuses schedules ticker via schedules.workflow_id
  | { type: 'manual' }
  | { type: 'channel_message' };  // @mention of the intake agent in the home channel starts a run

interface WorkflowRole {
  role: string;             // "Inbox triage"
  handle_seed: string;      // suggested handle when creating the agent ("scout")
  duties: string;           // prose, injected into the member's prompt section
  integrations: string[];   // integration keys this role wants connected
  participant_id?: string;  // bound agent (existing or created at finalize); unset in drafts
}
```

Intake role = `roster[0]` (receives the kickoff turn). New `ServerEvent`s (coarse, refetch-on-receipt like `schedule_changed`): `workflow_changed {workflowId, action}`, `workflow_run_changed {workflowId, runId}`.

## 4. Run lifecycle (backend: `services/workflows.ts`)

- **Start**: trigger fires (ticker branch on `schedules.workflow_id`; manual = HTTP route; channel-message = mention of the intake agent in the home channel) → create `workflow_runs` row → post run-header message in the home channel (`cascadeBudget: 0`) → dispatch ONE kickoff turn to the intake agent with `{workflowRunId}` context and a self-contained prompt (playbook + roster + "work in this thread"). Everything after that is the ordinary cascade — the intake agent mentions teammates; no new dispatch machinery.
- **During**: turns triggered from within the run thread inherit `workflowRunId` in their dispatch context (one change where the orchestrator builds context from a thread message). That's the entire run-scoping mechanism.
- **End**: any member calls `workflow_run_complete(summary)` (one new runner tool; the playbook tells the reporting role to use it). Fallbacks: manual Stop button; quiescence (all members idle, no pending confirmation, no thread activity for 30 min → done with an auto-summary note). No stage machine.
- **Stall**: ticker sweep — run `running`, no member turn/thread activity for 15 min, and no pending confirmation → `stalled` + notification (a pending approval is an approval, not a stall). One rule, no per-handoff timeouts.
- **Finalize** (draft/template → active): for each roster role, bind an existing agent or create one (persona = role duties + workflow blurb); create home channel (or link chosen one) + add members; create backing schedule row for cron triggers; set `active`. Member prompts get one generated "workflow" section (same mechanism as persona/memory sections).

## 5. Architect (conversational builder, v1)

- One system **Architect** agent per workspace (provisioned lazily; a normal runner-backed agent with a dedicated persona + tool set — same infra as `schedule_*` tools).
- **Draft protocol (whole-object, no patches)**: builder page opens a conversation with Architect about a `workflows` row with `status=draft`. Architect tools: `workflow_draft_set(draft)` (replaces the draft; server validates, persists, emits `workflow_changed`), `workflow_list_templates`, `workflow_get_draft`, `workflow_finalize`. The right pane refetches + re-renders the draft on each `workflow_changed`; config chips show trigger/home/connections, missing connections flagged.
- Finalize validates required integrations are connected (or marks them "connect later" — first run will surface it) and runs compile (§4).
- Template entry point: "Use template" → pre-populated draft + Architect opens with a contextual first message ("I've set up the support-triage team — want fixes as PRs? which repo?").

## 6. Frontend (big-bang IA)

**Prerequisite check at build start**: `refactor/architecture` branch — backend/shared portions are merged (current layered backend matches CLAUDE.md) but **App.tsx decomposition + WS-hook/state extraction were left unfinished**. Assess that branch first; either land its frontend remnants into `feat/workflows` Phase 1 or cherry-pick, because the IA rework needs a decomposed shell anyway. Do not build the new nav on top of the monolith twice.

- **Sidebar**: Home (badge = needs-you count), Workflows, Team, channels, DMs. Search stays ⌘K + pill.
- **Home**: sections Needs you (pending confirmations + stalled runs, actions inline) / While you were away (deliverables feed) / Live now (ambient activity) / Coming up (next trigger firings). All data sources exist today except stalled runs. Old `/approvals`, `/deliverables`, `/scheduled` routes redirect (deep links keep working).
- **Workflows**: gallery (workflow cards: team avatars, trigger chip, last-7-runs strip) + template gallery. Existing schedules render here as single-agent workflow cards (adapter; no data migration).
- **Detail**: generated diagram + tabs Overview / Runs / Playbook, team + connections + guardrails rails (per mockup).
- **Diagram**: layered auto-layout (columns = stages, fan-out within a column), SVG edges, live node states from `workflow.run.updated`. Not a free-form canvas; read-only in v1.
- **Run view**: staged timeline from run-scoped events/messages, inline approvals, artifacts rail (derive from deliverables tagged with run context), "Open thread" → home-channel thread.
- **Builder**: split pane chat + live draft preview (§5).

## 7. Launch templates

| Template | Shape | Exercises |
|---|---|---|
| Support triage / bug-fix crew | scanner → manager → 3 fixers → report | Gmail, Notion, GitHub, approval gates, full delegation |
| Daily standup digest | single agent → channel post | schedules-as-workflows story, Linear/GitHub, destination channel |
| Inbound lead research | scanner → researcher → DM brief | Gmail, web research; channel-message trigger variant |
| Content pipeline | drafter → editor (review loop) → publish | human-in-loop review, Notion/Drive, channel-message trigger ("@workflow new post idea: …") |

Each template must be run end-to-end on preprod with real connections before ship; templates are the product's front door and the QA matrix.

## 8. Build phases (within the one branch)

0. Shared types + templates module + migrations + workflows CRUD routes/db.
1. Frontend shell: finish App decomposition (see §6 prereq), new nav, Home consolidation, Team rename, Workflows gallery listing existing schedules + static template cards.
2. Compile + runs core: template instantiation (no Architect yet — direct "Use template" flow), run lifecycle, run threading, manual + cron triggers, run agent-tools, Runs UI + Run view.
3. Diagram component + Detail page.
4. Architect + draft protocol + Builder UI.
5. Channel-message trigger, stall detection, guardrails compile, Home "stalled" entries.
6. Template tuning (all 4 e2e on preprod), polish, redirects, docs, Slack-mirroring + workspaces interplay checks.

Ship gate: typecheck green, integration tests (`backend/test/integration-sdk.mjs` pattern) extended with a workflow-run test, all templates verified live on preprod, then prod.

## 9. Risks / open questions

- **Run-scoped context threading** through the cascade engine is the subtle part (which turns belong to a run when an agent is in several) — rule: run context propagates via the run thread + explicit dispatch, never via agent identity.
- **Stage inference** will be wrong sometimes → prefer explicit agent tools; treat inference as fallback display, never as enforcement.
- **Architect draft UX latency**: draft patches must feel instant; `workflow_draft_set` is a cheap DB write + WS fanout, so the bottleneck is Architect's own turn latency — keep its effort low, persona tight.
- **Home consolidation regressions**: approvals are load-bearing (agents block on them) — keep the approvals data path untouched, only re-skin.
- **Agent cost**: 5-agent templates multiply token spend per run; template personas should set effort knobs deliberately (fixers medium, scanner low).
- Open: per-workflow pause semantics for member agents that also do non-workflow work; run retention/archival; whether "Team" page gets workflow groupings in v1 (nice-to-have).
