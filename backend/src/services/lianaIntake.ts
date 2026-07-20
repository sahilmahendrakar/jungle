import Anthropic from "@anthropic-ai/sdk";

// Liana intake: one structured-output Messages call that turns a raw Slack message
// ("@Liana give me a morning briefing every day at 8am") into either a workflow draft spec,
// a list request, or a plain conversational reply. This is deliberately NOT a runner/agent —
// it's a single parse with a JSON schema, so it's fast, cheap to reason about, and stateless.

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
] as const;

export interface IntakeWorkflowSpec {
  name: string;
  prompt: string;
  integrations: string[];
  cron: string | null;
  timezone: string | null;
  repo: string | null;
}

export interface IntakeResult {
  intent: "create_workflow" | "list_workflows" | "chat";
  reply: string;
  workflow: IntakeWorkflowSpec | null;
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["create_workflow", "list_workflows", "chat"] },
    reply: {
      type: "string",
      description:
        "The message to send back in Slack. For create_workflow: one warm sentence restating what " +
        "will be set up (the confirm card shows the details separately). For chat: the full reply.",
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
              description: "5-field cron for recurring workflows, null for run-on-demand only.",
            },
            timezone: {
              anyOf: [{ type: "string" }, { type: "null" }],
              description: "IANA timezone for the cron. Default to the user's Slack timezone.",
            },
            repo: {
              anyOf: [{ type: "string" }, { type: "null" }],
              description: "owner/name GitHub repo, only when the user names one and github is used.",
            },
          },
          required: ["name", "prompt", "integrations", "cron", "timezone", "repo"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
  },
  required: ["intent", "reply", "workflow"],
  additionalProperties: false,
} as const;

function systemPrompt(ctx: IntakeContext): string {
  return (
    `You are Liana, a Slack assistant that sets up "workflows": standing instructions an agent ` +
    `runs on a schedule (or on demand), delivering the result back in Slack. Examples: a morning ` +
    `briefing across email/calendar/GitHub at 8am; a weekly Linear digest; a meeting-prep note ` +
    `before each day. You are the intake step: parse the user's message into a decision.\n\n` +
    `Intents:\n` +
    `- create_workflow: the user is asking for something automatable (recurring or on-demand). ` +
    `Fill the workflow object. Recurring language ("every morning", "weekly") -> a 5-field cron in ` +
    `the user's timezone; workflows may fire at most every 30 minutes. One-off or on-demand asks ` +
    `("whenever I say", "on demand") -> cron null.\n` +
    `- list_workflows: the user asks what workflows they have.\n` +
    `- chat: anything else (greetings, questions about what you can do). Answer briefly and steer ` +
    `toward what you're for. You cannot do ad-hoc tasks yourself — you only set up workflows.\n\n` +
    `Available integrations (only these keys): gmail (read/send the user's email), google-calendar ` +
    `(their calendar), google-drive (their Drive files), github (a repo: code, PRs, issues — set ` +
    `repo when named), x (their X/Twitter reading), linear (issues), notion (pages), granola ` +
    `(meeting notes). Pick only integrations the task actually needs. If the task needs one we ` +
    `don't have (e.g. Salesforce), say so honestly in the reply and leave it out.\n\n` +
    `Voice: competent and warm, brief, no exclamation-point pileups, no filler.\n\n` +
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
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic(); // ANTHROPIC_API_KEY from env (loaded by env.ts)
  return client;
}

export async function runIntake(message: string, ctx: IntakeContext): Promise<IntakeResult> {
  const response = await anthropic().messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2048,
    output_config: {
      format: { type: "json_schema" as const, schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> },
      effort: "medium" as const,
    },
    system: systemPrompt(ctx),
    messages: [{ role: "user", content: message }],
  });
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("intake: no text block in response");
  const parsed = JSON.parse(text.text) as IntakeResult;
  // Belt-and-suspenders: the schema enforces shape, but clamp the enum-adjacent fields anyway.
  if (parsed.intent === "create_workflow" && !parsed.workflow) parsed.intent = "chat";
  if (parsed.workflow) {
    parsed.workflow.integrations = parsed.workflow.integrations.filter((k) =>
      (INTAKE_INTEGRATION_KEYS as readonly string[]).includes(k),
    );
  }
  return parsed;
}
