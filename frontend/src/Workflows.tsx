import { useEffect, useState } from "react";
import cronstrue from "cronstrue";
import { CalendarClock, Loader2, MessageSquare, Plus, Square, Workflow as WorkflowIcon, Zap } from "lucide-react";
import type { Workflow, WorkflowTemplate } from "./api";
import { createWorkflowDraft, listWorkflows, listWorkflowTemplates, runWorkflow, stopWorkflowRun } from "./api";
import { fmtRelative } from "./lib/chat";
import { avatarClass, initials } from "./lib/people";
import { cn } from "./lib/utils";
import { ViewShell } from "./components/chat/ViewShell";
import { Scheduled } from "./Scheduled";
import { navigate } from "./route";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// The Workflows page: your workflows, the template gallery, and the workspace's plain scheduled
// tasks (this page absorbed the old /scheduled destination). Creating or editing a workflow
// happens on the visual builder page (/workflows/:id/edit); this page only lists and launches.

// Compressed schedule label for a card's trigger line: "Weekdays 8:00 AM", "Daily 7:30 AM".
// Weekday ranges and every-day crons get the short word + time; anything else falls back to
// cronstrue (never the long sentence for the common cases), unparseable to the raw expression.
function shortCadence(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length === 5) {
    const [minute, hour, dom, , dow] = fields;
    const h = Number(hour);
    const m = Number(minute);
    if (Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
      const time = new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const dowNorm = dow.toUpperCase();
      if (dom === "*" && (dowNorm === "1-5" || dowNorm === "MON-FRI")) return `Weekdays ${time}`;
      if (dom === "*" && dowNorm === "*") return `Daily ${time}`;
    }
  }
  try {
    return cronstrue.toString(cron, { verbose: false, throwExceptionOnParseError: true });
  } catch {
    return cron;
  }
}

function isLiveRun(w: Workflow): boolean {
  return w.last_run?.status === "running" || w.last_run?.status === "stalled";
}

// One short trigger line under the workflow name: icon + cadence/kind + home channel.
function triggerLine(w: Workflow): { icon: React.ReactNode; text: string } {
  const t = w.trigger;
  const channel = w.home_channel_name ? ` · #${w.home_channel_name}` : "";
  if (t.type === "schedule") {
    return { icon: <CalendarClock className="size-3" />, text: `${shortCadence(t.cron)}${channel}` };
  }
  if (t.type === "channel_message") return { icon: <MessageSquare className="size-3" />, text: `On message${channel}` };
  return { icon: <Zap className="size-3" />, text: "Manual" };
}

// Quiet dot + word in place of the old boxy badges (drafts keep their chip).
function statusIndicator(w: Workflow) {
  if (w.status === "draft") return <Badge variant="secondary" className="text-[10px]">Draft</Badge>;
  if (isLiveRun(w)) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold text-primary">
        <span className="size-1.5 animate-pulse rounded-full bg-primary" /> Running
      </span>
    );
  }
  if (w.status === "paused") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-slate-400/70" /> Paused
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
      <span className="size-1.5 rounded-full bg-emerald-500/60" /> Active
    </span>
  );
}

// One short phrase of run context next to the avatar stack.
function runInfo(w: Workflow): string | null {
  if (isLiveRun(w)) return `started ${fmtRelative(w.last_run!.started_at)}`;
  if (w.trigger.type === "schedule") {
    const parts: string[] = [];
    if (w.last_run) parts.push(`ran ${fmtRelative(w.last_run.started_at)}`);
    if (w.next_run_at) parts.push(`next ${fmtRelative(w.next_run_at)}`);
    return parts.length ? parts.join(" · ") : null;
  }
  return w.last_run ? `ran ${fmtRelative(w.last_run.started_at)}` : null;
}

// Overlapping faces of the roster seats (initials on the deterministic handle palette),
// capped at five with a +N overflow circle.
function RosterStack({ w, dimmed }: { w: Workflow; dimmed?: boolean }) {
  const shown = w.roster.slice(0, 5);
  const extra = w.roster.length - shown.length;
  return (
    <div className={cn("flex", dimmed && "opacity-55")}>
      {shown.map((r, i) => (
        <Avatar
          key={`${r.handle_seed}-${i}`}
          title={[r.role, r.name].filter(Boolean).join(" · ")}
          className={cn("size-5.5 rounded-full border-2 border-card", i > 0 && "-ml-1.5")}
        >
          <AvatarFallback className={cn(avatarClass(r.handle_seed), "rounded-full text-[9px] font-semibold")}>
            {initials(r.name ?? r.role)}
          </AvatarFallback>
        </Avatar>
      ))}
      {extra > 0 && (
        <Avatar className="-ml-1.5 size-5.5 rounded-full border-2 border-card">
          <AvatarFallback className="rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">
            +{extra}
          </AvatarFallback>
        </Avatar>
      )}
    </div>
  );
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
  const trig = triggerLine(w);
  const live = isLiveRun(w);
  const draft = w.status === "draft";
  const info = runInfo(w);
  return (
    <div
      data-testid="workflow-card"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(w)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(w)}
      className={cn(
        "group flex cursor-pointer flex-col rounded-xl border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/40",
        draft && "border-dashed bg-card/60",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-lg leading-none",
            draft && "bg-muted",
          )}
        >
          {w.emoji ? (
            <span className={cn(draft && "opacity-80 grayscale-[.4]")}>{w.emoji}</span>
          ) : (
            <WorkflowIcon className="size-4 text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm font-semibold", draft && "text-foreground/80")}>{w.name}</span>
          <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
            {draft ? "Draft — finish setting it up" : (<>{trig.icon}{trig.text}</>)}
          </span>
        </span>
        {statusIndicator(w)}
      </div>
      <div className="mt-3 flex items-center" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <RosterStack w={w} dimmed={draft} />
        {info && <span className="ml-2 text-[11px] text-muted-foreground">{info}</span>}
        {draft ? (
          <Button size="sm" variant="outline" onClick={() => onOpen(w)} className="ml-auto h-6.5 text-xs font-medium">
            Continue setup
          </Button>
        ) : live ? (
          <Button size="sm" variant="outline" disabled={busy} data-testid="workflow-stop" onClick={() => onStop(w)} className="ml-auto h-6.5 text-xs font-medium">
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Square className="size-3" />} Stop
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={busy || w.status === "paused"} data-testid="workflow-run" onClick={() => onRun(w)} className="ml-auto h-6.5 text-xs font-medium">
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Zap className="size-3" />} Run
          </Button>
        )}
      </div>
    </div>
  );
}

function TemplateCard({ t, busy, onUse }: { t: WorkflowTemplate; busy: boolean; onUse: (t: WorkflowTemplate) => void }) {
  return (
    <div data-testid="workflow-template-card" className="flex items-center gap-2.5 rounded-xl border bg-card px-3.5 py-3 shadow-sm">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-lg leading-none">{t.emoji}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{t.name}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {t.tagline} · {t.roster.length} agent{t.roster.length === 1 ? "" : "s"}
        </span>
      </span>
      <Button
        size="icon"
        variant="outline"
        disabled={busy}
        aria-label="Use template"
        data-testid="use-template"
        onClick={() => onUse(t)}
        className="size-7 shrink-0 rounded-full"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
      </Button>
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
  const [creating, setCreating] = useState<string | null>(null); // template id, or "blank"
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

  const reload = () => void listWorkflows().then(setWorkflows).catch(() => {});

  // Creating a draft (blank or from a template) drops you straight into the visual builder.
  async function newDraft(templateId?: string) {
    setCreating(templateId ?? "blank");
    try {
      const draft = await createWorkflowDraft(templateId ? { templateId } : {});
      navigate(`/workflows/${draft.id}/edit`);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setCreating(null);
    }
  }

  function openWorkflow(w: Workflow) {
    // Drafts open the builder to finish setup; live workflows open their detail page.
    navigate(w.status === "draft" ? `/workflows/${w.id}/edit` : `/workflows/${w.id}`);
    if (w.status !== "draft") onOpenWorkflow(w);
  }

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
          <section data-testid="your-workflows">
            <div className="mb-2 flex items-center px-1">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Your workflows</h2>
              <Button size="sm" data-testid="new-workflow" disabled={creating === "blank"} onClick={() => newDraft()} className="ml-auto h-7 text-xs">
                {creating === "blank" ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                New workflow
              </Button>
            </div>
            {workflows.length === 0 ? (
              <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                A workflow is a small team of agents with a trigger and a playbook. Start from a
                template below, or build one from scratch.
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {workflows.map((w) => (
                  <WorkflowCard key={w.id} w={w} busy={busyId === w.id} onOpen={openWorkflow} onRun={runNow} onStop={stopRun} />
                ))}
              </div>
            )}
          </section>

          <section data-testid="workflow-templates">
            <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Start from a template</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {templates.map((t) => (
                <TemplateCard key={t.id} t={t} busy={creating === t.id} onUse={(tt) => newDraft(tt.id)} />
              ))}
            </div>
          </section>

          {workspaceId && (
            <section data-testid="workflows-scheduled">
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scheduled tasks</h2>
              <Scheduled workspaceId={workspaceId} embedded />
            </section>
          )}
        </div>
      )}
    </ViewShell>
  );
}
