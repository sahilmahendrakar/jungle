import * as db from "../db";
import * as directory from "../services/directory";
import * as agentAdmin from "../services/agentAdmin";
import * as workflows from "../services/workflows";
import * as scheduler from "../services/scheduler";
import { readAgentHistory } from "../services/orchestrator";
import { broadcastWorkspace } from "../ws/appSocket";
import { ApiError } from "../http/errors";

// The Jungle MCP toolset: everything a workspace member can do, exposed as MCP tools with an
// explicit ACTOR (the API token's participant — human or agent; see mcp/server.ts for the
// transport/auth). Handlers return the tool's text output and throw ApiError for user-facing
// failures — the server renders those as isError tool results, not protocol errors.
//
// Tools marked readOnly are safe to auto-run without a confirmation; the jungle integration
// adapter (integrations/jungle.ts) uses that flag to build the runner's safeTools list.

export interface JungleTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  handler: (actor: db.Participant, args: Record<string, unknown>) => Promise<string>;
}

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({ type: "object", properties, required });

const str = (description: string): Record<string, unknown> => ({ type: "string", description });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "@handle" or a participant id -> the participant, workspace-scoped through the actor.
async function resolveParticipant(actor: db.Participant, ref: string): Promise<db.Participant> {
  const clean = String(ref ?? "").trim().replace(/^@/, "");
  if (!clean) throw new ApiError(400, "participant reference required");
  const p = UUID_RE.test(clean)
    ? await db.getParticipant(clean)
    : await db.getParticipantByHandle(actor.workspace_id, clean);
  if (!p || p.workspace_id !== actor.workspace_id) throw new ApiError(404, `no participant "${ref}"`);
  return p;
}

async function resolveAgent(actor: db.Participant, ref: string): Promise<db.Participant> {
  const p = await resolveParticipant(actor, ref);
  if (p.kind !== "agent") throw new ApiError(400, `@${p.handle} is not an agent`);
  return p;
}

// The optional `onBehalfOf` argument on the integration tools: the PERSON whose connected account
// should back a connection-based integration. An agent holds no connections of its own, so when an
// agent attaches gmail/notion/… it acts for a human (integrations/backing.ts picks one when this
// is omitted and the choice is unambiguous).
async function resolveOnBehalfOf(actor: db.Participant, ref: unknown): Promise<db.Participant | null> {
  if (ref === undefined || ref === null || String(ref).trim() === "") return null;
  const p = await resolveParticipant(actor, String(ref));
  if (p.kind === "agent") throw new ApiError(400, `onBehalfOf must be a person, and @${p.handle} is an agent`);
  return p;
}

const ON_BEHALF_OF_DESC =
  '"@handle" of the person whose connected account backs connection-based integrations ' +
  "(gmail, notion, …). Optional: needed only when several people have connected one.";

// "#name" or a channel id -> the channel id. Member-scoped for names (same rule as send_message);
// ids are checked for workspace + membership by the directory functions downstream.
async function resolveChannelId(actor: db.Participant, ref: string): Promise<string> {
  const clean = String(ref ?? "").trim();
  if (!clean) throw new ApiError(400, "channel reference required");
  if (UUID_RE.test(clean)) return clean;
  const ch = await db.getChannelByNameForMember(clean.replace(/^#/, ""), actor.id);
  if (!ch) throw new ApiError(404, `you are not a member of channel ${clean} (or it doesn't exist)`);
  return ch.id;
}

async function requireWorkflow(actor: db.Participant, id: string): Promise<db.WorkflowRow> {
  const row = await db.getWorkflow(String(id ?? "")).catch(() => null);
  if (!row || row.workspace_id !== actor.workspace_id) throw new ApiError(404, "workflow not found");
  return row;
}

// The workflow tool functions (services/workflows.ts) take a db.AgentRow but only read
// id/workspace_id — any participant satisfies that (precedent: toolFinalize's own cast).
const asAgentRow = (p: db.Participant) => p as unknown as db.AgentRow;

function renderToolResult(r: { ok: boolean; error?: string; text?: string; draftId?: string; workflowId?: string }): string {
  if (!r.ok) throw new ApiError(400, r.error ?? "failed");
  const ids = [r.draftId ? `draftId: ${r.draftId}` : null, r.workflowId ? `workflowId: ${r.workflowId}` : null]
    .filter(Boolean)
    .join(", ");
  return [r.text, ids].filter(Boolean).join("\n") || "Done.";
}

export const JUNGLE_TOOLS: JungleTool[] = [
  // --- Messaging ---
  {
    name: "send_message",
    description:
      'Send a chat message into Jungle. `to` is a channel like "#general" (you must be a member) ' +
      'or a handle like "@alice" (opens/reuses your DM). @mention an agent in the body to trigger ' +
      "it. Optionally reply inside a thread via threadRootId.",
    inputSchema: obj(
      {
        to: str('Destination: "#channel" or "@handle"'),
        body: str("The message text to post"),
        threadRootId: str("Reply inside a thread, by the root message's id (optional)"),
        alsoToChannel: { type: "boolean", description: "When replying in a thread, also post to the channel timeline" },
      },
      ["to", "body"],
    ),
    handler: async (actor, args) => {
      const r = await directory.postMessageAs(actor, {
        to: String(args.to ?? ""),
        body: String(args.body ?? ""),
        threadRootId: args.threadRootId ? String(args.threadRootId) : null,
        alsoToChannel: !!args.alsoToChannel,
      });
      if (!r.ok) throw new ApiError(400, r.error);
      return `Message sent (id ${r.messageId}).`;
    },
  },
  {
    name: "read_history",
    description:
      'Read a channel or DM\'s message history, newest page first. `to` is "#channel" or ' +
      '"@handle". Pass threadRootId for a thread\'s transcript, beforeSeq (from a previous ' +
      "call's oldestSeq) to page further back, limit 1-50 (default 20).",
    inputSchema: obj(
      {
        to: str('Destination: "#channel" or "@handle"'),
        threadRootId: str("Read a specific thread (root message id) instead of the timeline"),
        beforeSeq: str("Page older than this cursor (from a previous call's oldestSeq)"),
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max messages (default 20)" },
      },
      ["to"],
    ),
    readOnly: true,
    handler: async (actor, args) => {
      const r = await readAgentHistory(actor, {
        to: String(args.to ?? ""),
        threadRootId: args.threadRootId ? String(args.threadRootId) : undefined,
        beforeSeq: args.beforeSeq ? String(args.beforeSeq) : undefined,
        limit: args.limit !== undefined ? Number(args.limit) : undefined,
      });
      if (!r.ok) throw new ApiError(400, r.error ?? "failed");
      const body = r.text?.trim().length ? r.text : "(no messages)";
      return r.oldestSeq ? `${body}\n\n(to page further back, pass beforeSeq:"${r.oldestSeq}")` : `${body}\n\n(no earlier messages)`;
    },
  },

  // --- Channels & people ---
  {
    name: "list_channels",
    description: "List the channels and DMs you are a member of (name, kind, id, agent members).",
    inputSchema: obj({}),
    readOnly: true,
    handler: async (actor) => {
      const rows = await db.listChannels(actor.id);
      if (!rows.length) return "You are not a member of any channels.";
      return rows
        .map((c) =>
          c.kind === "dm"
            ? `DM with @${c.dm_with ?? "?"} (id ${c.id})`
            : `#${c.name} (id ${c.id})${c.member_agent_ids.length ? ` — ${c.member_agent_ids.length} agent member(s)` : ""}`,
        )
        .join("\n");
    },
  },
  {
    name: "list_participants",
    description: "List everyone in the workspace — humans and agents — with their handles.",
    inputSchema: obj({}),
    readOnly: true,
    handler: async (actor) => {
      const rows = await db.listParticipants(actor.workspace_id);
      return rows.map((p) => `@${p.handle} — ${p.display_name} (${p.kind}, id ${p.id})`).join("\n");
    },
  },
  {
    name: "list_connections",
    description:
      "List the workspace's connected accounts (Notion workspaces, Gmail/Drive/Calendar, Linear, " +
      "Granola, X) with their owner and connection id. A person can hold several accounts for one " +
      "integration, so this is how you find the connectionId to pass to attach_integration.",
    inputSchema: obj({ key: str('Only this integration key, e.g. "notion" (optional)') }),
    readOnly: true,
    handler: async (actor, args) => {
      const key = String(args.key ?? "").trim();
      const lines: string[] = [];
      for (const person of await db.listParticipants(actor.workspace_id)) {
        if (person.kind === "agent") continue; // connections belong to people, never to agents
        for (const c of await db.listIntegrationConnections(person.id)) {
          if (key && c.integration_key !== key) continue;
          const flag = c.needs_reconnect ? " — NEEDS RECONNECT" : "";
          lines.push(
            `${c.integration_key}: ${c.external_account ?? "(unnamed)"} — @${person.handle}, ` +
              `connectionId ${c.id}${flag}`,
          );
        }
      }
      if (!lines.length) {
        return key
          ? `Nobody in this workspace has connected ${key} yet — a person connects it in Settings → Connections.`
          : "No connected accounts in this workspace yet.";
      }
      return lines.join("\n");
    },
  },
  {
    name: "create_channel",
    description:
      "Create a channel. You are always a member; memberHandles adds others (agents included) at creation.",
    inputSchema: obj(
      {
        name: str('Channel name, e.g. "ops" (leading # allowed)'),
        memberHandles: { type: "array", items: { type: "string" }, description: "Handles to add as members" },
      },
      ["name"],
    ),
    handler: async (actor, args) => {
      const ch = await directory.createChannelAs(actor, {
        name: String(args.name ?? ""),
        memberHandles: Array.isArray(args.memberHandles) ? args.memberHandles.map(String) : [],
      });
      return `Created #${ch.name} (id ${ch.id}).`;
    },
  },
  {
    name: "add_channel_member",
    description: "Add a participant (human or agent) to a channel you belong to.",
    inputSchema: obj(
      { channel: str('"#name" or channel id'), handle: str("The participant to add, e.g. \"@scout\"") },
      ["channel", "handle"],
    ),
    handler: async (actor, args) => {
      const channelId = await resolveChannelId(actor, String(args.channel ?? ""));
      const target = await directory.addChannelMemberAs(actor, channelId, String(args.handle ?? ""));
      return `Added @${target.handle}.`;
    },
  },
  {
    name: "remove_channel_member",
    description: "Remove a participant from a channel you belong to.",
    inputSchema: obj(
      { channel: str('"#name" or channel id'), handle: str("The participant to remove") },
      ["channel", "handle"],
    ),
    handler: async (actor, args) => {
      const channelId = await resolveChannelId(actor, String(args.channel ?? ""));
      const target = await resolveParticipant(actor, String(args.handle ?? ""));
      await directory.removeChannelMemberAs(actor, channelId, target.id);
      return `Removed @${target.handle}.`;
    },
  },

  // --- Agents ---
  {
    name: "create_agent",
    description:
      "Create a new agent in the workspace: a blank chat agent on its own cloud machine. " +
      'Optional integrations attach at creation, e.g. [{"key":"github","config":{"repo":"owner/name"}}]. ' +
      "The agent joins channels when @mentioned or added.",
    inputSchema: obj(
      {
        handle: str('The agent\'s @handle, e.g. "scout"'),
        displayName: str("Display name"),
        persona: str("Instructions/persona injected into the agent's system prompt (optional)"),
        model: str("Model override (optional; workspace default otherwise)"),
        integrations: {
          type: "array",
          items: obj({ key: str("integration key"), config: { type: "object" } }, ["key"]),
          description: "Integrations to attach at creation (optional)",
        },
        onBehalfOf: str(ON_BEHALF_OF_DESC),
      },
      ["handle", "displayName"],
    ),
    handler: async (actor, args) => {
      const agent = await agentAdmin.createAgentAs(actor, {
        handle: String(args.handle ?? ""),
        displayName: String(args.displayName ?? ""),
        persona: args.persona,
        model: args.model ? String(args.model) : null,
        integrations: args.integrations,
        onBehalfOf: await resolveOnBehalfOf(actor, args.onBehalfOf),
      });
      return `Created agent @${agent.handle} (id ${agent.id}). It is provisioning and will come online shortly.`;
    },
  },
  {
    name: "get_agent",
    description: "An agent's configuration: model, mode, persona, attached integrations.",
    inputSchema: obj({ agent: str('"@handle" or agent id') }, ["agent"]),
    readOnly: true,
    handler: async (actor, args) => {
      const agent = await resolveAgent(actor, String(args.agent ?? ""));
      const integrations = await db.listAgentIntegrations(agent.id);
      return [
        `@${agent.handle} — ${agent.display_name} (id ${agent.id})`,
        `model: ${agent.model ?? "(default)"} · mode: ${agent.mode} · effort: ${agent.effort}`,
        `persona: ${agent.persona ?? "(none)"}`,
        `integrations: ${integrations.length ? integrations.map((i) => i.integration_key).join(", ") : "(none)"}`,
      ].join("\n");
    },
  },
  {
    name: "update_agent",
    description:
      "Update an agent's config: displayName, persona (empty string clears), model, mode " +
      "(default|acceptEdits|plan|bypassPermissions|dontAsk), effort (low|medium|high|xhigh).",
    inputSchema: obj(
      {
        agent: str('"@handle" or agent id'),
        displayName: str("New display name (optional)"),
        persona: str("New persona; empty string clears (optional)"),
        model: str("New model (optional)"),
        mode: str("New permission mode (optional)"),
        effort: str("New reasoning effort (optional)"),
      },
      ["agent"],
    ),
    handler: async (actor, args) => {
      const agent = await resolveAgent(actor, String(args.agent ?? ""));
      await agentAdmin.updateAgentConfigAs(actor, agent.id, {
        displayName: args.displayName,
        persona: args.persona,
        mode: args.mode,
        model: args.model,
        effort: args.effort,
      });
      return `Updated @${agent.handle}.`;
    },
  },
  {
    name: "delete_agent",
    description:
      "PERMANENTLY delete an agent: its machine, workspace files, messages and memory. Cannot be undone.",
    inputSchema: obj({ agent: str('"@handle" or agent id') }, ["agent"]),
    handler: async (actor, args) => {
      const agent = await resolveAgent(actor, String(args.agent ?? ""));
      await agentAdmin.deleteAgentAs(actor, agent.id);
      return `Deleted @${agent.handle}.`;
    },
  },
  {
    name: "attach_integration",
    description:
      'Attach (or reconfigure) an integration on an agent, e.g. key "github" with config ' +
      '{"repo":"owner/name"}. Connection-based integrations (gmail, notion, linear, …) bind to a ' +
      "PERSON'S connected account: yours if you're a human, otherwise the workspace member who " +
      "connected it (name them with onBehalfOf if more than one has). To pick a specific account " +
      'when someone has several, pass config {"connectionId":"…"} from list_connections.',
    inputSchema: obj(
      {
        agent: str('"@handle" or agent id'),
        key: str('Integration key, e.g. "github" or "gmail"'),
        config: {
          type: "object",
          description:
            "Integration config (per its settings fields); connectionId picks one specific " +
            "connected account (see list_connections)",
        },
        onBehalfOf: str(ON_BEHALF_OF_DESC),
      },
      ["agent", "key"],
    ),
    handler: async (actor, args) => {
      const agent = await resolveAgent(actor, String(args.agent ?? ""));
      const config = args.config && typeof args.config === "object" ? (args.config as Record<string, unknown>) : {};
      const onBehalfOf = await resolveOnBehalfOf(actor, args.onBehalfOf);
      await agentAdmin.attachIntegrationAs(actor, agent.id, String(args.key ?? ""), config, onBehalfOf);
      return `Attached ${args.key} to @${agent.handle}.`;
    },
  },
  {
    name: "detach_integration",
    description: "Detach an integration from an agent (revokes its grant at the next turn).",
    inputSchema: obj({ agent: str('"@handle" or agent id'), key: str("Integration key") }, ["agent", "key"]),
    handler: async (actor, args) => {
      const agent = await resolveAgent(actor, String(args.agent ?? ""));
      await agentAdmin.detachIntegrationAs(actor, agent.id, String(args.key ?? ""));
      return `Detached ${args.key} from @${agent.handle}.`;
    },
  },

  // --- Workflows ---
  {
    name: "list_workflows",
    description: "List the workspace's workflows (drafts and live) with status and trigger.",
    inputSchema: obj({}),
    readOnly: true,
    handler: async (actor) => {
      const rows = await db.listWorkspaceWorkflows(actor.workspace_id);
      if (!rows.length) return "No workflows yet.";
      return rows
        .map((w) => `${w.name} (id ${w.id}) — ${w.status}, trigger: ${w.trigger.type}, ${w.roster.length} seat(s)`)
        .join("\n");
    },
  },
  {
    name: "workflow_list_templates",
    description: "List the available workflow templates (id, shape, trigger) to start a draft from.",
    inputSchema: obj({}),
    readOnly: true,
    handler: async () => renderToolResult(await workflows.toolListTemplates()),
  },
  {
    name: "workflow_draft_create",
    description:
      "Create a workflow DRAFT — blank or pre-filled from a template id. Drafts cost nothing until finalized.",
    inputSchema: obj({
      templateId: str("Template to pre-fill from (see workflow_list_templates)"),
      name: str("Workflow name (optional)"),
    }),
    handler: async (actor, args) =>
      renderToolResult(
        await workflows.toolDraftCreate(asAgentRow(actor), {
          templateId: args.templateId ? String(args.templateId) : undefined,
          name: args.name ? String(args.name) : undefined,
        }),
      ),
  },
  {
    name: "workflow_draft_get",
    description: "Read a workflow draft (team, trigger, playbook) by draftId.",
    inputSchema: obj({ draftId: str("The draft's id") }, ["draftId"]),
    readOnly: true,
    handler: async (actor, args) =>
      renderToolResult(await workflows.toolDraftGet(asAgentRow(actor), { draftId: String(args.draftId ?? "") })),
  },
  {
    name: "workflow_draft_set",
    description:
      "Update a workflow draft. Provide only the fields you're changing; roster replaces the " +
      "whole team when given. roster[0] is the intake seat; every seat becomes a fresh agent at finalize.",
    inputSchema: obj(
      {
        draftId: str("The draft's id"),
        name: str("Workflow name (optional)"),
        description: str("One human-facing sentence: what this workflow does (optional)"),
        emoji: str("Emoji for the workflow card (optional)"),
        trigger: {
          type: "object",
          description:
            'How runs start: {"type":"schedule","cron":"0 9 * * 1-5","timezone":"America/Los_Angeles"} | {"type":"manual"} | {"type":"channel_message"}',
        },
        roster: {
          type: "array",
          description: "The team, in order. Each seat: {role, handle_seed, duties, integrations?, repo?}",
          items: obj(
            {
              role: str('Seat name, e.g. "Inbox triage"'),
              handle_seed: str('Handle hint for the new agent, e.g. "scout"'),
              duties: str("Prose duties for this seat (becomes the agent's persona)"),
              integrations: { type: "array", items: { type: "string" } },
              repo: str('owner/name of the GitHub repo, when integrations includes "github"'),
            },
            ["role", "handle_seed", "duties"],
          ),
        },
        playbook: str("Prose: who does what in a run, who reports, ending with a 'Run complete: …' thread message"),
      },
      ["draftId"],
    ),
    handler: async (actor, args) =>
      renderToolResult(
        await workflows.toolDraftSet(
          asAgentRow(actor),
          args as unknown as Parameters<typeof workflows.toolDraftSet>[1],
        ),
      ),
  },
  {
    name: "workflow_finalize",
    description:
      "Turn a draft into a LIVE workflow: creates any new agents, the home channel, and the " +
      "trigger. Real machines get created — only call when it should really go live.",
    inputSchema: obj(
      {
        draftId: str("The draft's id"),
        homeChannel: str('Adopt an existing channel as home, e.g. "#ops" (default: a new channel)'),
      },
      ["draftId"],
    ),
    handler: async (actor, args) =>
      renderToolResult(
        await workflows.toolFinalize(asAgentRow(actor), {
          draftId: String(args.draftId ?? ""),
          homeChannel: args.homeChannel ? String(args.homeChannel) : undefined,
        }),
      ),
  },
  {
    name: "workflow_run",
    description: "Start a manual run of a live workflow now.",
    inputSchema: obj({ workflowId: str("The workflow's id") }, ["workflowId"]),
    handler: async (actor, args) => {
      const wf = await requireWorkflow(actor, String(args.workflowId ?? ""));
      const run = await workflows.startRun(wf, "manual");
      return `Run started (id ${run.id}).`;
    },
  },
  {
    name: "workflow_set_paused",
    description: "Pause (true) or resume (false) a live workflow's trigger.",
    inputSchema: obj(
      { workflowId: str("The workflow's id"), paused: { type: "boolean" } },
      ["workflowId", "paused"],
    ),
    handler: async (actor, args) => {
      const wf = await requireWorkflow(actor, String(args.workflowId ?? ""));
      const updated = await workflows.setWorkflowPaused(wf, Boolean(args.paused));
      return `${updated.name} is now ${updated.status}.`;
    },
  },

  // --- Schedules ---
  {
    name: "schedule_create",
    description:
      "Create a standing schedule: an agent runs a self-contained prompt on a cadence " +
      "(cron + IANA timezone) or once (runAt, ISO-8601). The prompt runs with no memory of this " +
      "conversation — make it fully self-contained.",
    inputSchema: obj(
      {
        agent: str('The agent that runs it: "@handle" or id'),
        channel: str('Context channel for confirmations/notices: "#name" or id'),
        prompt: str("The standing instruction (self-contained, max 4000 chars)"),
        cron: str('5-field cron, e.g. "0 9 * * 1-5" (with timezone; OR use runAt)'),
        timezone: str('IANA timezone, e.g. "America/Los_Angeles" (required with cron)'),
        runAt: str("One-time ISO-8601 timestamp (instead of cron)"),
      },
      ["agent", "channel", "prompt"],
    ),
    handler: async (actor, args) => {
      const agent = await resolveAgent(actor, String(args.agent ?? ""));
      const channelId = await resolveChannelId(actor, String(args.channel ?? ""));
      const row = await scheduler.createScheduleChecked({
        workspaceId: actor.workspace_id,
        agentId: agent.id,
        channelId,
        createdBy: actor.id,
        spec: {
          prompt: String(args.prompt ?? ""),
          cron: args.cron ? String(args.cron) : undefined,
          timezone: args.timezone ? String(args.timezone) : undefined,
          runAt: args.runAt ? String(args.runAt) : undefined,
        },
        announce: false,
      });
      return `Scheduled (id ${row.id}).${row.next_run_at ? ` Next run: ${row.next_run_at}.` : ""}`;
    },
  },
  {
    name: "schedule_list",
    description: "List the workspace's schedules (agent, cadence, next run, prompt).",
    inputSchema: obj({}),
    readOnly: true,
    handler: async (actor) => {
      const rows = await db.listWorkspaceSchedules(actor.workspace_id);
      if (!rows.length) return "No schedules.";
      return rows
        .map((s) => {
          const status = s.paused_at ? "PAUSED" : s.next_run_at ? `next run ${s.next_run_at}` : "completed";
          const prompt = s.prompt.length > 80 ? s.prompt.slice(0, 79) + "…" : s.prompt;
          return `- ${s.id} [${scheduler.cadenceText(s)}] ${status}\n  "${prompt}"`;
        })
        .join("\n");
    },
  },
  {
    name: "schedule_cancel",
    description: "Cancel (permanently delete) a schedule by id.",
    inputSchema: obj({ scheduleId: str("The schedule's id") }, ["scheduleId"]),
    handler: async (actor, args) => {
      const id = String(args.scheduleId ?? "").trim();
      const row = await db.getSchedule(id).catch(() => null);
      if (!row || row.workspace_id !== actor.workspace_id) throw new ApiError(404, "schedule not found");
      await db.deleteSchedule(id);
      broadcastWorkspace(row.workspace_id, { type: "schedule_changed", scheduleId: id, action: "deleted" });
      return "Schedule cancelled.";
    },
  },
];

// Tool names safe to auto-run without a human confirmation (read-only).
export const SAFE_JUNGLE_TOOLS = JUNGLE_TOOLS.filter((t) => t.readOnly).map((t) => t.name);
