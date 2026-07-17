import { useEffect, useState } from "react";
import {
  Bot,
  CalendarClock,
  Hash,
  Loader2,
  MessageSquare,
  Play,
  Square,
  Trash2,
  Users,
  Workflow as WorkflowIcon,
  Zap,
} from "lucide-react";
import type { Participant, Workflow, WorkflowRole, WorkflowTemplate } from "./api";
import {
  createWorkflowDraft,
  deleteWorkflow,
  finalizeWorkflow,
  listParticipants,
  listWorkflows,
  listWorkflowTemplates,
  runWorkflow,
  stopWorkflowRun,
  updateWorkflow,
} from "./api";
import { fmtRelative } from "./lib/chat";
import { ViewShell } from "./components/chat/ViewShell";
import { Scheduled } from "./Scheduled";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// The Workflows page: your workflows (teams of agents on a trigger), the template gallery, and
// the workspace's plain scheduled tasks (this page absorbed the old /scheduled destination — a
// schedule is just a one-agent workflow without the ceremony). Workflow detail/builder routes
// hang off /workflows/:id.

function triggerLabel(w: Workflow): { icon: React.ReactNode; text: string } {
  const t = w.trigger;
  if (t.type === "schedule") {
    return {
      icon: <CalendarClock className="size-3" />,
      text: w.next_run_at ? `Next run ${fmtRelative(w.next_run_at)}` : "On a schedule",
    };
  }
  if (t.type === "channel_message") {
    return { icon: <MessageSquare className="size-3" />, text: "Starts from a message" };
  }
  return { icon: <Zap className="size-3" />, text: "Run manually" };
}

function statusBadge(w: Workflow) {
  if (w.status === "draft") return <Badge variant="secondary" className="text-[10px]">Draft</Badge>;
  if (w.status === "paused") return <Badge variant="secondary" className="text-[10px]">Paused</Badge>;
  const live = w.last_run && (w.last_run.status === "running" || w.last_run.status === "stalled");
  if (live) {
    return (
      <Badge className="gap-1 bg-primary/15 text-[10px] text-primary hover:bg-primary/15">
        <span className="size-1.5 animate-pulse rounded-full bg-primary" /> Running
      </Badge>
    );
  }
  return <Badge variant="outline" className="text-[10px] text-primary">Active</Badge>;
}

function WorkflowCard({
  w,
  busy,
  onOpen,
  onRun,
  onStop,
}: {
  w: Workflow;
  busy: boolean;
  onOpen: (w: Workflow) => void;
  onRun: (w: Workflow) => void;
  onStop: (w: Workflow) => void;
}) {
  const trig = triggerLabel(w);
  const liveRun = w.last_run && (w.last_run.status === "running" || w.last_run.status === "stalled");
  return (
    <div
      data-testid="workflow-card"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(w)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(w)}
      className="group flex cursor-pointer flex-col rounded-xl border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/40"
    >
      <div className="flex items-center gap-2">
        {w.emoji && <span className="text-lg leading-none">{w.emoji}</span>}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{w.name}</span>
        {statusBadge(w)}
      </div>
      {w.description && (
        <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{w.description}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Users className="size-3" />
          {w.roster.length} agent{w.roster.length === 1 ? "" : "s"}
        </span>
        <span className="inline-flex items-center gap-1">{trig.icon}{trig.text}</span>
        {w.home_channel_name && (
          <span className="inline-flex items-center gap-0.5">
            <Hash className="size-3" />
            {w.home_channel_name}
          </span>
        )}
        {w.last_run && !liveRun && <span>Last run {fmtRelative(w.last_run.started_at)}</span>}
      </div>
      <div className="mt-3 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        {w.status === "draft" ? (
          <span className="text-xs text-muted-foreground">Click to review &amp; create the team</span>
        ) : liveRun ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="workflow-stop"
            onClick={() => onStop(w)}
            className="h-7 text-xs"
          >
            <Square className="size-3" /> Stop run
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy || w.status === "paused"}
            data-testid="workflow-run"
            onClick={() => onRun(w)}
            className="h-7 text-xs"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Zap className="size-3" />} Run now
          </Button>
        )}
      </div>
    </div>
  );
}

// Review & create: the draft -> active step. Shows the team (with per-role "create new" vs an
// existing agent), the trigger, and the editable playbook — one Create button does the rest
// (agents, home channel, schedule). The conversational builder replaces most of this later; the
// dialog IS the fallback editor.
function FinalizeDialog({
  workflow,
  onClose,
  onCreated,
}: {
  workflow: Workflow;
  onClose: () => void;
  onCreated: (w: Workflow) => void;
}) {
  const [roster, setRoster] = useState<WorkflowRole[]>(workflow.roster);
  const [playbook, setPlaybook] = useState(workflow.playbook);
  const [agents, setAgents] = useState<Participant[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listParticipants()
      .then((ps) => setAgents(ps.filter((p) => p.kind === "agent")))
      .catch(() => {});
  }, []);

  const trig = workflow.trigger;
  const trigText =
    trig.type === "schedule"
      ? `On a schedule (${trig.cron}, ${trig.timezone})`
      : trig.type === "channel_message"
        ? "When someone @mentions the first agent in the home channel"
        : "Run manually";

  async function create() {
    setCreating(true);
    setError(null);
    try {
      await updateWorkflow(workflow.id, { roster, playbook });
      const created = await finalizeWorkflow(workflow.id);
      onCreated(created);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !creating && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {workflow.emoji} {workflow.name}
          </DialogTitle>
          <DialogDescription>
            Creating this workflow sets up the team below, a home channel for its runs, and the
            trigger. Nothing runs until the trigger fires (or you hit Run now).
          </DialogDescription>
        </DialogHeader>

        {/* min-w-0: DialogContent is a grid; without it these rows' nowrap text refuses to
            shrink and overflows the dialog's right edge. */}
        <div className="min-w-0 space-y-4">
          <div className="min-w-0">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Team</Label>
            <div className="mt-1.5 space-y-2">
              {roster.map((r, i) => (
                <div key={i} className="flex min-w-0 items-center gap-2.5 rounded-lg border p-2.5">
                  <Bot className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {r.role}
                      {i === 0 && (
                        <span className="ml-1.5 text-[10px] font-semibold uppercase text-primary">goes first</span>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground" title={r.duties}>
                      {r.duties}
                    </div>
                  </div>
                  <select
                    data-testid="role-binding"
                    className="h-8 shrink-0 rounded-md border bg-background px-2 text-xs"
                    value={r.participant_id ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setRoster((prev) =>
                        prev.map((role, j) =>
                          j === i
                            ? v
                              ? { ...role, participant_id: v }
                              : (({ participant_id: _drop, ...rest }) => rest)(role)
                            : role,
                        ),
                      );
                    }}
                  >
                    <option value="">New agent (@{r.handle_seed})</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        @{a.handle}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>

          <div>
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Trigger</Label>
            <p className="mt-1 text-sm">{trigText}</p>
          </div>

          <div>
            <Label htmlFor="wf-playbook" className="text-xs uppercase tracking-wide text-muted-foreground">
              Playbook — how the team runs
            </Label>
            <Textarea
              id="wf-playbook"
              value={playbook}
              onChange={(e) => setPlaybook(e.target.value)}
              rows={5}
              className="mt-1.5 text-xs leading-relaxed"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={creating} onClick={onClose}>
            Cancel
          </Button>
          <Button data-testid="workflow-create" disabled={creating} onClick={create}>
            {creating ? <Loader2 className="size-4 animate-spin" /> : null}
            {creating ? "Creating team…" : "Create workflow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TemplateCard({
  t,
  busy,
  onUse,
}: {
  t: WorkflowTemplate;
  busy: boolean;
  onUse: (t: WorkflowTemplate) => void;
}) {
  return (
    <div
      data-testid="workflow-template-card"
      className="flex flex-col rounded-xl border bg-card p-4 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <span className="text-lg leading-none">{t.emoji}</span>
        <span className="text-sm font-semibold">{t.name}</span>
      </div>
      <p className="mt-1.5 flex-1 text-xs leading-relaxed text-muted-foreground">{t.description}</p>
      <div className="mt-3 flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Users className="size-3" />
          {t.roster.length} agent{t.roster.length === 1 ? "" : "s"}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onUse(t)}
          className="ml-auto h-7 text-xs"
          data-testid="use-template"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          Use template
        </Button>
      </div>
    </div>
  );
}

export function Workflows({
  workspaceId,
  sidebarOpen,
  onOpenDrawer,
  onExpandSidebar,
  onOpenWorkflow,
}: {
  workspaceId: string;
  sidebarOpen: boolean;
  onOpenDrawer: () => void;
  onExpandSidebar: () => void;
  onOpenWorkflow: (w: Workflow) => void;
}) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingTemplate, setUsingTemplate] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState<Workflow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void Promise.allSettled([listWorkflows(), listWorkflowTemplates()]).then(([w, t]) => {
        if (!alive) return;
        if (w.status === "fulfilled") setWorkflows(w.value);
        if (t.status === "fulfilled") setTemplates(t.value);
        setLoading(false);
      });
    };
    load();
    window.addEventListener("jungle:workflow-changed", load);
    return () => {
      alive = false;
      window.removeEventListener("jungle:workflow-changed", load);
    };
  }, [workspaceId]);

  async function useTemplate(t: WorkflowTemplate) {
    setUsingTemplate(t.id);
    try {
      const draft = await createWorkflowDraft({ templateId: t.id });
      setWorkflows((prev) => [draft, ...prev]);
      setFinalizing(draft); // straight into review & create — the draft alone does nothing
    } finally {
      setUsingTemplate(null);
    }
  }

  const reload = () => void listWorkflows().then(setWorkflows).catch(() => {});

  async function runNow(w: Workflow) {
    setBusyId(w.id);
    try {
      await runWorkflow(w.id);
      reload();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function stopRun(w: Workflow) {
    if (!w.last_run) return;
    setBusyId(w.id);
    try {
      await stopWorkflowRun(w.id, w.last_run.id);
      reload();
    } finally {
      setBusyId(null);
    }
  }

  function openWorkflow(w: Workflow) {
    if (w.status === "draft") setFinalizing(w);
    else onOpenWorkflow(w);
  }

  return (
    <ViewShell
      icon={<WorkflowIcon className="size-5" />}
      title="Workflows"
      sidebarOpen={sidebarOpen}
      onOpenDrawer={onOpenDrawer}
      onExpandSidebar={onExpandSidebar}
      testId="workflows-view"
    >
      {loading ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : (
        <div className="space-y-8">
          {/* Your workflows */}
          <section data-testid="your-workflows">
            <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Your workflows
            </h2>
            {workflows.length === 0 ? (
              <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                A workflow is a small team of agents with a trigger and a playbook — pick a
                template below to see how one fits together.
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {workflows.map((w) => (
                  <WorkflowCard
                    key={w.id}
                    w={w}
                    busy={busyId === w.id}
                    onOpen={openWorkflow}
                    onRun={runNow}
                    onStop={stopRun}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Templates */}
          <section data-testid="workflow-templates">
            <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Start from a template
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {templates.map((t) => (
                <TemplateCard key={t.id} t={t} busy={usingTemplate === t.id} onUse={useTemplate} />
              ))}
            </div>
          </section>

          {/* Plain scheduled tasks (the old /scheduled page, embedded). Workspace-scoped, so it
              only renders in Firebase mode — same gate the standalone /scheduled page had. */}
          {workspaceId && (
            <section data-testid="workflows-scheduled">
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Scheduled tasks
              </h2>
              <Scheduled workspaceId={workspaceId} embedded />
            </section>
          )}
        </div>
      )}

      {finalizing && (
        <FinalizeDialog
          workflow={finalizing}
          onClose={() => setFinalizing(null)}
          onCreated={(w) => {
            setFinalizing(null);
            setWorkflows((prev) => prev.map((x) => (x.id === w.id ? { ...x, ...w } : x)));
            reload();
          }}
        />
      )}
    </ViewShell>
  );
}
