// The launch workflow templates. Code, not DB (like the integration catalog): a template is a
// pre-filled Workflow draft — roster seeds + a prose playbook + a default trigger. Instantiating
// one copies these fields onto a draft the user can edit; nothing here is referenced again after
// finalize except template_id (provenance for analytics/UI).
//
// Playbooks are written TO THE AGENTS (they're injected into member prompt sections verbatim,
// with the roster and run context around them). Keep them short, imperative, and honest about
// approvals — the fewer moving parts a playbook implies, the fewer ways a run can wedge.

import type { WorkflowRole, WorkflowTrigger } from "./workflows.js";

export interface WorkflowTemplate {
  id: string;
  name: string;
  emoji: string;
  description: string; // one gallery sentence, written to the human
  trigger: WorkflowTrigger;
  roster: WorkflowRole[]; // roster[0] = intake
  playbook: string;
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "support-triage",
    name: "Support triage",
    emoji: "🛟",
    description:
      "Scan a support inbox every morning, file real bugs to a tracker, and dispatch a fix crew on the worst ones.",
    trigger: { type: "schedule", cron: "0 8 * * 1-5", timezone: "America/Los_Angeles" },
    roster: [
      {
        role: "Inbox triage",
        handle_seed: "scout",
        duties:
          "Read new mail in the support inbox since the last run. Separate real product bugs from questions and noise. File each bug (severity, repro notes, affected users) in the team's bug tracker, then hand the list to the manager.",
        integrations: ["gmail", "notion"],
        stage: 1,
      },
      {
        role: "Manager",
        handle_seed: "ledger",
        duties:
          "Prioritize the bugs from triage, assign each to one fixer by @mention with a crisp brief, chase progress, and when fixes are in, post the run summary and complete the run.",
        integrations: [],
        stage: 2,
        edge_label: "bugs",
      },
      {
        role: "Fixer",
        handle_seed: "rex",
        duties:
          "Fix assigned bugs in the team repo: reproduce, patch, add a regression test, open a PR, and report the PR link back to the manager. Raise blockers early instead of spinning.",
        integrations: ["github"],
        stage: 3,
        edge_label: "assigns",
      },
      {
        role: "Fixer",
        handle_seed: "juno",
        duties:
          "Fix assigned bugs in the team repo: reproduce, patch, add a regression test, open a PR, and report the PR link back to the manager. Raise blockers early instead of spinning.",
        integrations: ["github"],
        stage: 3,
      },
    ],
    playbook:
      "Each run: triage scans the support inbox and files real bugs; the manager prioritizes and " +
      "assigns each bug to one fixer; fixers open PRs and report back. Work in the run thread. " +
      "Pushes and anything customer-visible go through the usual approval flow — wait for it, " +
      "don't route around it. When every assigned bug has a PR (or a documented blocker), the " +
      "manager posts a thread message starting with \"Run complete:\" summarizing bugs found, " +
      "PRs opened, and anything stuck. If the inbox has nothing actionable, post " +
      "\"Run complete: nothing to do\" — an empty run is a normal outcome.",
  },
  {
    id: "standup-digest",
    name: "Daily standup digest",
    emoji: "📋",
    description:
      "One agent collects yesterday's PRs, tracker movement, and blockers into a single morning digest posted to a channel.",
    trigger: { type: "schedule", cron: "30 7 * * 1-5", timezone: "America/Los_Angeles" },
    roster: [
      {
        role: "Reporter",
        handle_seed: "daily",
        duties:
          "Collect what changed since yesterday — merged/open PRs, issue tracker movement, anything that looks blocked — and post one tight digest to the destination channel.",
        integrations: ["github", "linear"],
      },
    ],
    playbook:
      "Each run: gather yesterday's activity from the connected tools and post ONE digest " +
      "message to the destination channel named in your instructions (default: this workflow's " +
      "home channel). Lead with what shipped, then what's in flight, then blockers. No filler — " +
      "if nothing happened, one line saying so. Then post \"Run complete:\" plus a one-line " +
      "summary in the run thread.",
  },
  {
    id: "lead-research",
    name: "Inbound lead research",
    emoji: "🔎",
    description:
      "When a lead reaches out, research the company and person and drop a crisp brief in your DMs before the call.",
    trigger: { type: "channel_message" },
    roster: [
      {
        role: "Intake",
        handle_seed: "greeter",
        duties:
          "Take the lead from the triggering message (a name, company, email, or a forwarded thread), pull any context from the connected inbox, and hand the researcher one clear research request.",
        integrations: ["gmail"],
        stage: 1,
      },
      {
        role: "Researcher",
        handle_seed: "digger",
        duties:
          "Research the company and person — product, size, funding, recent news, likely need for us — and DM the workflow's creator a brief: who they are, why now, suggested talking points, and a fit score with one sentence of reasoning.",
        integrations: [],
        stage: 2,
        edge_label: "lead",
      },
    ],
    playbook:
      "A run starts when someone @mentions intake in the home channel with a lead. Intake " +
      "extracts who/what and briefs the researcher; the researcher works in the run thread and " +
      "DMs the final brief to the workflow's creator. Keep the brief under ~300 words — it's " +
      "read on the way into a call. After sending the brief, the researcher posts " +
      "\"Run complete:\" plus one line in the run thread. If the message contains no identifiable " +
      "lead, intake asks once in the thread and completes the run the same way if there's no answer.",
  },
  {
    id: "content-pipeline",
    name: "Content pipeline",
    emoji: "✍️",
    description:
      "Turn a rough idea into a drafted, edited post — a writer drafts, an editor pushes back, you get the final for sign-off.",
    trigger: { type: "channel_message" },
    roster: [
      {
        role: "Writer",
        handle_seed: "quill",
        duties:
          "Turn the idea from the triggering message into a full draft in the team's docs tool, matching any voice/style notes in this playbook. Revise per the editor's feedback until the editor approves.",
        integrations: ["notion"],
        stage: 1,
      },
      {
        role: "Editor",
        handle_seed: "redpen",
        duties:
          "Hold the quality bar: critique the draft's structure, claims, and voice concretely (quote the weak parts). Approve only when you'd publish it yourself, then send the final link to the workflow's creator for sign-off.",
        integrations: [],
        stage: 2,
        edge_label: "draft",
      },
    ],
    playbook:
      "A run starts when someone @mentions the writer in the home channel with an idea. The " +
      "writer drafts in the docs tool and posts the link in the run thread; the editor reviews " +
      "and they iterate (at most two revision rounds — then ship the best version rather than " +
      "looping). The editor DMs the workflow's creator the final link for sign-off, then posts " +
      "\"Run complete:\" plus one line in the run thread. Nothing is published anywhere without " +
      "the creator's explicit OK.",
  },
];

export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}
