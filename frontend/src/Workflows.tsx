import { useEffect, useState } from "react";
import { CalendarClock, Hash, Loader2, MessageSquare, Play, Users, Workflow as WorkflowIcon, Zap } from "lucide-react";
import type { Workflow, WorkflowTemplate } from "./api";
import { createWorkflowDraft, listWorkflows, listWorkflowTemplates } from "./api";
import { fmtRelative } from "./lib/chat";
import { ViewShell } from "./components/chat/ViewShell";
import { Scheduled } from "./Scheduled";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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

function WorkflowCard({ w, onOpen }: { w: Workflow; onOpen: (w: Workflow) => void }) {
  const trig = triggerLabel(w);
  return (
    <button
      data-testid="workflow-card"
      onClick={() => onOpen(w)}
      className="group flex flex-col rounded-xl border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/40"
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
        {w.last_run && w.last_run.status !== "running" && (
          <span>Last run {fmtRelative(w.last_run.started_at)}</span>
        )}
      </div>
    </button>
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
      onOpenWorkflow(draft);
    } finally {
      setUsingTemplate(null);
    }
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
                  <WorkflowCard key={w.id} w={w} onOpen={onOpenWorkflow} />
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
    </ViewShell>
  );
}
