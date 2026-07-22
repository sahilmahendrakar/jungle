import Anthropic from "@anthropic-ai/sdk";
import { resolveProvider } from "../providers";

// Liana intake: one structured Messages call that turns a raw Slack message
// ("@Liana give me a morning briefing every day at 8am") into either a workflow draft spec,
// a list request, or a plain conversational reply. This is deliberately NOT a runner/agent —
// it's a single parse against a JSON schema: fast and cheap to reason about. Conversation
// memory (ctx.history, a bounded window from liana_messages) is just wider input to the same
// stateless parse — no session lives here.
//
// Structured output via a FORCED TOOL CALL (tool_choice: the one tool), not output_config —
// the forced-tool pattern works on every Anthropic-compatible provider (Moonshot/Kimi, z.ai/GLM)
// the same way it does first-party, so the intake model is a free choice from the shared
// MODEL_CATALOG. Provider routing mirrors the runner's (providers.ts).

// Integration keys the intake may propose. Kept in sync by hand with the subset of
// @jungle/shared INTEGRATION_TYPES that Liana supports end-to-end (attachable + runner tools).
const INTAKE_INTEGRATION_KEYS = [
  "gmail",
  "google-calendar",
  "google-drive",
  "github",
  "x",
  "linear",
  "notion",
  "granola",
  "posthog",
  "mixpanel",
] as const;

export interface IntakeWorkflowSpec {
  name: string;
  prompt: string;
  integrations: string[];
  cron: string | null;
  // Local datetime "YYYY-MM-DDTHH:MM" for a ONE-TIME run at a specific future time; null otherwise.
  // At most one of cron / runAt is non-null (both null = run on demand).
  runAt: string | null;
  timezone: string | null;
  repo: string | null;
}

// A partial edit to an EXISTING workflow — only the fields the user asked to change are set.
// Mirrors editLianaWorkflow's args. `approvals` maps an integration key to whether the agent must
// ask before it acts (false = act without asking). `repo` sets the GitHub repo.
export interface IntakeEditPatch {
  name?: string;
  prompt?: string;
  cron?: string | null;
  runAt?: string | null;
  timezone?: string | null;
  paused?: boolean;
  integrations?: string[];
  repo?: string | null;
  approvals?: Record<string, boolean>;
  deliverTo?: string[];
}

export interface IntakeEdit {
  workflowRef: number; // the #N of the target workflow in ctx.existingWorkflows
  patch: IntakeEditPatch;
}

export interface IntakeResult {
  intent: "create_workflow" | "list_workflows" | "edit_workflow" | "chat";
  reply: string;
  workflow: IntakeWorkflowSpec | null;
  edit: IntakeEdit | null;
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["create_workflow", "list_workflows", "edit_workflow", "chat"] },
    reply: {
      type: "string",
      description:
        "The message to send back in Slack. For create_workflow: one warm sentence restating what " +
        "will be set up (the confirm card shows the details separately). For edit_workflow: one warm " +
        "sentence confirming the change (it applies immediately, no card). For chat: the full reply.",
    },
    workflow: {
      anyOf: [
        {
          type: "object",
          properties: {
            name: { type: "string", description: "Short title, e.g. 'Morning briefing'" },
            prompt: {
              type: "string",
              description:
                "The standing instruction the workflow's agent will run each time, written in second " +
                "person ('Summarize my unread email…'). Self-contained: the agent has no other context.",
            },
            integrations: {
              type: "array",
              items: { type: "string", enum: [...INTAKE_INTEGRATION_KEYS] },
            },
            cron: {
              anyOf: [{ type: "string" }, { type: "null" }],
              description: "5-field cron for RECURRING workflows, null otherwise.",
            },
            runAt: {
              anyOf: [{ type: "string" }, { type: "null" }],
              description:
                "Local datetime 'YYYY-MM-DDTHH:MM' for a ONE-TIME run at a specific future time " +
                "(e.g. 'tomorrow at 3pm', 'next Monday at 9am'), resolved in the user's timezone " +
                "from today's date. null otherwise. At most one of cron / runAt is non-null.",
            },
            timezone: {
              anyOf: [{ type: "string" }, { type: "null" }],
              description: "IANA timezone for cron or runAt. Default to the user's Slack timezone.",
            },
            repo: {
              anyOf: [{ type: "string" }, { type: "null" }],
              description: "owner/name GitHub repo, only when the user names one and github is used.",
            },
          },
          required: ["name", "prompt", "integrations", "cron", "runAt", "timezone", "repo"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
    edit: {
      description:
        "Set ONLY for intent edit_workflow: which existing workflow to change and the fields to " +
        "change. Include only the fields the user actually asked to change; omit the rest.",
      anyOf: [
        {
          type: "object",
          properties: {
            workflowRef: { type: "number", description: "The #N of the target workflow in the existing-workflows list." },
            patch: {
              type: "object",
              properties: {
                name: { type: "string" },
                prompt: { type: "string", description: "Replacement standing instruction (second person, self-contained)." },
                cron: { anyOf: [{ type: "string" }, { type: "null" }], description: "New 5-field cron; null switches to on-demand." },
                runAt: { anyOf: [{ type: "string" }, { type: "null" }], description: "New one-time local 'YYYY-MM-DDTHH:MM'; null switches off." },
                timezone: { anyOf: [{ type: "string" }, { type: "null" }] },
                paused: { type: "boolean", description: "true to pause, false to resume." },
                integrations: {
                  type: "array",
                  items: { type: "string", enum: [...INTAKE_INTEGRATION_KEYS] },
                  description: "The FULL new integration list (not a delta): existing + added, minus removed.",
                },
                repo: { anyOf: [{ type: "string" }, { type: "null" }], description: "owner/name GitHub repo to switch to." },
                approvals: {
                  type: "object",
                  additionalProperties: { type: "boolean" },
                  description:
                    "Per-integration 'ask me first' toggle, keyed by integration. false = act without " +
                    "asking ('let it send email without asking me' -> {\"gmail\": false}); true = ask first.",
                },
                deliverTo: {
                  type: "array",
                  items: { type: "string", enum: ["slack", "imessage", "telegram"] },
                  description: "The FULL new set of channels to deliver runs to ('also text me' -> add imessage).",
                },
              },
              additionalProperties: false,
            },
          },
          required: ["workflowRef", "patch"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
  },
  required: ["intent", "reply", "workflow", "edit"],
  additionalProperties: false,
} as const;

function systemPrompt(ctx: IntakeContext): string {
  return (
    `You are Liana, a Slack assistant that sets up "workflows": standing instructions an agent ` +
    `runs on a schedule (or on demand), delivering the result back in Slack. Examples: a morning ` +
    `briefing across email/calendar/GitHub at 8am; a weekly Linear digest; a meeting-prep note ` +
    `before each day. You are the intake step: parse the user's message into a decision.\n\n` +
    `Intents:\n` +
    `- create_workflow: the user is asking for something automatable (recurring, one-time, or ` +
    `on-demand). Fill the workflow object. Choose the cadence:\n` +
    `  • Recurring language ("every morning", "weekly", "each weekday at 8am") -> a 5-field cron in ` +
    `the user's timezone (runAt null); workflows may fire at most every 30 minutes.\n` +
    `  • A specific future time ("tomorrow at 3pm", "next Monday at 9am", "on Friday at noon", ` +
    `"in 2 hours") -> runAt as local "YYYY-MM-DDTHH:MM" resolved from today's date in the user's ` +
    `timezone (cron null). Compute the calendar date carefully from today's date and weekday below.\n` +
    `  • Open-ended / on-demand ("whenever I say", "on demand", no time given) -> both cron and ` +
    `runAt null.\n` +
    `- edit_workflow: the user wants to CHANGE one of their EXISTING workflows (listed below with ` +
    `#N handles) — reschedule it, rename it, change the prompt, add/remove an integration, switch ` +
    `the GitHub repo, change delivery channels, pause/resume, or change whether it asks before ` +
    `acting. Set edit.workflowRef to the #N of the target and edit.patch to ONLY the fields that ` +
    `change. integrations and deliverTo, if changed, are the FULL new list (not a delta). For ` +
    `"stop asking before it sends email" set patch.approvals {"gmail": false}; for "ask me before ` +
    `it changes Notion" set {"notion": true}. Edits apply immediately — reply is one warm sentence.\n` +
    `- list_workflows: the user asks what workflows they have.\n` +
    `- chat: anything else (greetings, questions about what you can do). Answer briefly and steer ` +
    `toward what you're for. You cannot do ad-hoc tasks yourself — you only set up workflows.\n\n` +
    `Available integrations (only these keys): gmail (read/send the user's email), google-calendar ` +
    `(their calendar), google-drive (their Drive files), github (a repo: code, PRs, issues — set ` +
    `repo when named), x (their X/Twitter reading), linear (issues), notion (pages), granola ` +
    `(meeting notes), posthog (product analytics: events, insights, trends, funnels), mixpanel ` +
    `(product analytics: queries, reports, metrics). Pick only integrations the task actually needs. If the task needs one we ` +
    `don't have (e.g. Salesforce), say so honestly in the reply and leave it out.\n\n` +
    `Voice: competent and warm, brief, no exclamation-point pileups, no filler.\n\n` +
    `You may be mid-conversation: a "Conversation so far" transcript can precede the latest ` +
    `message. Use it to resolve references ("actually make it 9am", "add calendar to that"). ` +
    `Transcript lines marked "Liana:" are messages you already sent, in rendered chat form — ` +
    `never imitate or re-send that form; you only ever answer the latest message. A request to ` +
    `change something you just PROPOSED but haven't created yet IS intent create_workflow: emit ` +
    `the full updated workflow object with the change applied. A request to change one of the ` +
    `EXISTING workflows listed below is intent edit_workflow. The facts in THIS prompt (today's ` +
    `date, the workflow list) are current and authoritative — trust them over anything older in ` +
    `the transcript.\n\n` +
    `Context: today is ${ctx.today}. The user is ${ctx.userName}` +
    `${ctx.userTz ? ` (timezone ${ctx.userTz})` : ""}.` +
    `${
      ctx.existingWorkflows.length
        ? ` Their existing workflows: ${ctx.existingWorkflows.join("; ")}.`
        : " They have no workflows yet."
    }`
  );
}

export interface IntakeContext {
  userName: string;
  userTz: string | null;
  today: string; // e.g. "Monday 2026-07-20"
  existingWorkflows: string[]; // "Morning briefing (daily 8:00 AM)"
  // Bounded rolling transcript of this conversation (oldest first), from liana_messages. The
  // intake stays a single stateless parse — history is just wider input.
  history?: IntakeTurn[];
}

export interface IntakeTurn {
  role: "user" | "assistant";
  body: string;
}

// History rides INSIDE the single user message as a labeled transcript, not as native
// user/assistant turns. Tested the native form: Moonshot (kimi) ignores a forced tool_choice
// whenever an assistant turn precedes it and just continues the chat as prose — which silently
// disables structured output on the default model. Flattening keeps the call shape identical to
// the history-less case (one user message, forced tool call) on every provider.
function buildUserContent(history: IntakeTurn[], current: string): string {
  if (!history.length) return current;
  const lines = history.map((t) => `${t.role === "user" ? "User" : "Liana"}: ${t.body}`);
  return `Conversation so far:\n${lines.join("\n")}\n\nLatest message from the user:\n${current}`;
}

// One client per provider endpoint (first-party = the plain env-keyed client). Routed providers
// authenticate with a bearer token, matching how the runner overrides ANTHROPIC_AUTH_TOKEN.
const clients = new Map<string, Anthropic>();
function clientFor(model: string): Anthropic {
  const p = resolveProvider(model);
  const key = p?.baseUrl ?? "anthropic";
  let c = clients.get(key);
  if (!c) {
    c = p ? new Anthropic({ baseURL: p.baseUrl, authToken: p.authToken, apiKey: null }) : new Anthropic();
    clients.set(key, c);
  }
  return c;
}

// Fallback for compat endpoints that answer the forced tool call with plain text: pull the first
// top-level JSON object out of the text.
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("intake: no JSON in response");
  return text.slice(start, end + 1);
}

export async function runIntake(message: string, ctx: IntakeContext, model: string): Promise<IntakeResult> {
  const response = await clientFor(model).messages.create({
    model,
    max_tokens: 2048,
    // Thinking off: intake is a parse, and providers with thinking-on-by-default (Moonshot/Kimi)
    // reject forced tool_choice while thinking is enabled. Accepted by every catalog model.
    thinking: { type: "disabled" },
    system: systemPrompt(ctx),
    messages: [{ role: "user", content: buildUserContent(ctx.history ?? [], message) }],
    tools: [
      {
        name: "intake_result",
        description: "Report your parse of the user's message. Always call this exactly once.",
        input_schema: OUTPUT_SCHEMA as unknown as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: "intake_result" },
  });

  // Result extraction, most-structured first: (1) the forced tool call; (2) JSON in a text
  // block; (3) plain prose — some providers answer conversational turns naturally even under a
  // forced tool_choice, and that prose IS a perfectly good chat reply, so use it as one.
  let parsed: IntakeResult;
  const toolUse = response.content.find((b) => b.type === "tool_use");
  const text = response.content.find((b) => b.type === "text");
  if (toolUse && toolUse.type === "tool_use") {
    parsed = toolUse.input as IntakeResult;
  } else if (text && text.type === "text") {
    try {
      parsed = JSON.parse(extractJson(text.text)) as IntakeResult;
    } catch {
      parsed = { intent: "chat", reply: text.text.trim(), workflow: null, edit: null };
    }
  } else {
    throw new Error("intake: no tool_use or text block in response");
  }

  // Belt-and-suspenders: the schema shapes the output, but clamp the enum-adjacent fields anyway
  // (open models are looser about schema adherence than first-party structured outputs).
  if (!["create_workflow", "list_workflows", "edit_workflow", "chat"].includes(parsed.intent)) parsed.intent = "chat";
  if (parsed.intent === "create_workflow" && !parsed.workflow) parsed.intent = "chat";
  // An edit with no target ref (or no such workflow) is unusable — fall back to chat so the
  // caller can ask the user to clarify rather than mutating the wrong workflow.
  if (parsed.intent === "edit_workflow" && (!parsed.edit || typeof parsed.edit.workflowRef !== "number")) {
    parsed.intent = "chat";
    parsed.edit = null;
  }
  if (parsed.intent !== "edit_workflow") parsed.edit = null;
  if (typeof parsed.reply !== "string" || !parsed.reply.trim()) {
    parsed.reply = parsed.workflow ? "Here's what I'll set up:" : "Tell me what you'd like automated.";
  }
  if (parsed.workflow) {
    parsed.workflow.integrations = (parsed.workflow.integrations ?? []).filter((k) =>
      (INTAKE_INTEGRATION_KEYS as readonly string[]).includes(k),
    );
    // Cron and runAt are mutually exclusive; if a looser model returns both, one-time wins.
    if (parsed.workflow.runAt) parsed.workflow.cron = null;
    else if (parsed.workflow.runAt === undefined) parsed.workflow.runAt = null;
  }
  if (parsed.edit?.patch) {
    const p = parsed.edit.patch;
    if (p.integrations)
      p.integrations = p.integrations.filter((k) => (INTAKE_INTEGRATION_KEYS as readonly string[]).includes(k));
    if (p.runAt) p.cron = null; // mutual exclusion, one-time wins
  }
  return parsed;
}
