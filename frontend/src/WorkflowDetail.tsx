import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Square,
  Trash2,
  Workflow as WorkflowIcon,
  Zap,
} from "lucide-react";
import type { Participant, Workflow, WorkflowRun } from "./api";
import {
  deleteWorkflow,
  getWorkflow,
  listWorkflowRuns,
  runWorkflow,
  stopWorkflowRun,
  updateWorkflow,
} from "./api";
import { fmtRelative } from "./lib/chat";
import { ViewShell } from "./components/chat/ViewShell";
import { PersonAvatar } from "./components/chat/panels";
import {
  ConnectionsPanel,
  WorkflowCanvas,
  connectedIntegrationKeys,
  triggerSentence,
} from "./components/workflow/WorkflowCanvas";
import { useConnections } from "./lib/connections";
import { navigate } from "./route";
import { DeleteWorkflowDialog } from "./components/workflow/DeleteWorkflowDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// One workflow: the live canvas (same one the builder edits), its runs, and the playbook.
// Deliberately thin — a run's timeline IS its thread in the home channel (chat-native), so
// "open a run" jumps there rather than to a bespoke timeline surface.

function runStatusBadge(r: WorkflowRun) {
  if (r.status === "running")
    return (
      <Badge className="gap-1 bg-primary/15 text-[10px] text-primary hover:bg-primary/15">
        <span className="size-1.5 animate-pulse rounded-full bg-primary" /> Running
      </Badge>
    );
  if (r.status === "stalled") return <Badge variant="secondary" className="text-[10px] text-amber-600">Stalled</Badge>;
  if (r.status === "stopped") return <Badge variant="secondary" className="text-[10px]">Stopped</Badge>;
  return <Badge variant="outline" className="text-[10px] text-primary">Done</Badge>;
}

function duration(r: WorkflowRun): string {
  const end = r.ended_at ? new Date(r.ended_at).getTime() : Date.now();
  const mins = Math.max(1, Math.round((end - new Date(r.started_at).getTime()) / 60_000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function WorkflowDetail({
  workflowId,
  participants,
  sidebarOpen,
  onOpenDrawer,
  onExpandSidebar,
  onOpenAgent,
  onOpenConnections,
  onOpenRunThread,
}: {
  workflowId: string;
  participants: Participant[];
  sidebarOpen: boolean;
  onOpenDrawer: () => void;
  onExpandSidebar: () => void;
  onOpenAgent: (id: string) => void;
  onOpenConnections: () => void;
  onOpenRunThread: (channelId: string, rootMessageId: string) => void;
}) {
  const [w, setW] = useState<Workflow | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [tab, setTab] = useState<"overview" | "runs" | "playbook">("overview");
  const [playbook, setPlaybook] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const connections = useConnections(true);
  const connectedKeys = useMemo(() => connectedIntegrationKeys(connections.connections), [connections.connections]);
  const byId = useMemo(() => new Map(participants.map((p) => [p.id, p])), [participants]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void getWorkflow(workflowId).then((wf) => {
        if (!alive) return;
        setW(wf);
        setPlaybook((p) => (p ? p : wf.playbook));
      }).catch(() => alive && setW(null));
      void listWorkflowRuns(workflowId).then((rs) => alive && setRuns(rs)).catch(() => {});
    };
    load();
    window.addEventListener("jungle:workflow-changed", load);
    return () => {
      alive = false;
      window.removeEventListener("jungle:workflow-changed", load);
    };
  }, [workflowId]);

  const liveRun = runs.find((r) => r.status === "running" || r.status === "stalled");

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      window.dispatchEvent(new CustomEvent("jungle:workflow-changed"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!w) {
    return (
      <ViewShell icon={<WorkflowIcon className="size-5" />} title="Workflow" sidebarOpen={sidebarOpen} onOpenDrawer={onOpenDrawer} onExpandSidebar={onExpandSidebar} testId="workflow-detail">
        <div className="flex justify-center py-12 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
      </ViewShell>
    );
  }

  return (
    <ViewShell
      icon={<WorkflowIcon className="size-5" />}
      title={`${w.emoji ? w.emoji + " " : ""}${w.name}`}
      sidebarOpen={sidebarOpen}
      onOpenDrawer={onOpenDrawer}
      onExpandSidebar={onExpandSidebar}
      testId="workflow-detail"
    >
      {/* Header row: back link, status, the trigger in plain English, actions. */}
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <button onClick={() => navigate("/workflows")} className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          ← All workflows
        </button>
        <span className="ml-1">
          {w.status === "draft" ? <Badge variant="secondary">Draft</Badge> : w.status === "paused" ? <Badge variant="secondary">Paused</Badge> : <Badge variant="outline" className="text-primary">Active</Badge>}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" data-testid="detail-edit" onClick={() => navigate(`/workflows/${w.id}/edit`)} className="h-8 text-xs">
            <Pencil className="size-3.5" /> Edit
          </Button>
          {w.status !== "draft" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => act(() => updateWorkflow(w.id, { paused: w.status === "active" }))}
              className="h-8 text-xs"
            >
              {w.status === "active" ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              {w.status === "active" ? "Pause" : "Resume"}
            </Button>
          )}
          {liveRun ? (
            <Button size="sm" variant="outline" disabled={busy} data-testid="detail-stop" onClick={() => act(() => stopWorkflowRun(w.id, liveRun.id))} className="h-8 text-xs">
              <Square className="size-3.5" /> Stop run
            </Button>
          ) : (
            <Button size="sm" disabled={busy || w.status !== "active"} data-testid="detail-run" onClick={() => act(() => runWorkflow(w.id))} className="h-8 text-xs">
              <Zap className="size-3.5" /> Run now
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            data-testid="detail-delete"
            onClick={() => setDeleting(true)}
            aria-label="Delete workflow"
            title="Delete workflow"
            className="h-8 px-2 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <p className="mb-4 text-sm text-muted-foreground" data-testid="trigger-sentence">
        {triggerSentence(w)}
        {w.next_run_at && <span> · next run {fmtRelative(w.next_run_at)}</span>}
      </p>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

      {/* Tabs */}
      <div className="mb-4 flex gap-1 border-b">
        {(["overview", "runs", "playbook"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize",
              tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "runs" ? `Runs · ${runs.length}` : t}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="space-y-5">
          <WorkflowCanvas
            w={w}
            participants={participants}
            connectedKeys={connectedKeys}
            onSelectAgent={onOpenAgent}
            onOpenConnections={onOpenConnections}
          />
          {w.description && <p className="text-sm text-muted-foreground">{w.description}</p>}
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent runs</h2>
              <RunsList runs={runs.slice(0, 5)} w={w} onOpenRunThread={onOpenRunThread} />
            </div>
            <div className="space-y-5">
              <div>
                <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Team</h2>
                <div className="overflow-hidden rounded-xl border bg-card shadow-sm" data-testid="workflow-team">
                  {w.roster.map((r, i) => {
                    const p = r.participant_id ? byId.get(r.participant_id) : undefined;
                    return (
                      <div
                        key={r.participant_id ?? i}
                        role={p ? "button" : undefined}
                        onClick={() => p && onOpenAgent(p.id)}
                        className={cn("flex items-center gap-2.5 px-3 py-2", i > 0 && "border-t", p && "cursor-pointer hover:bg-accent/50")}
                      >
                        <PersonAvatar name={p?.display_name ?? r.name ?? r.handle_seed} handle={p?.handle ?? r.handle_seed} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{p?.display_name ?? r.name ?? `@${r.handle_seed}`}</div>
                          <div className="truncate text-xs text-muted-foreground">{r.role}</div>
                        </div>
                        {p?.status === "working" && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div>
                <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Connections</h2>
                <ConnectionsPanel w={w} connectedKeys={connectedKeys} onOpenConnections={onOpenConnections} />
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "runs" && <RunsList runs={runs} w={w} onOpenRunThread={onOpenRunThread} />}

      {tab === "playbook" && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            The playbook is the team's standing instruction — every member sees it, word for word. Edits apply from the next run.
          </p>
          <Textarea value={playbook} onChange={(e) => setPlaybook(e.target.value)} rows={10} className="text-sm leading-relaxed" />
          <div className="flex items-center gap-3">
            <Button size="sm" disabled={busy || playbook === w.playbook} onClick={() => act(() => updateWorkflow(w.id, { playbook }))}>
              Save playbook
            </Button>
          </div>
        </div>
      )}

      <DeleteWorkflowDialog
        workflow={deleting ? w : null}
        liveRun={!!liveRun}
        onOpenChange={setDeleting}
        onConfirm={async () => {
          await deleteWorkflow(w.id);
          navigate("/workflows");
        }}
      />
    </ViewShell>
  );
}

function RunsList({
  runs,
  w,
  onOpenRunThread,
}: {
  runs: WorkflowRun[];
  w: Workflow;
  onOpenRunThread: (channelId: string, rootMessageId: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        No runs yet — hit Run now, or wait for the trigger.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      {runs.map((r, i) => (
        <div
          key={r.id}
          data-testid="run-row"
          className={cn("flex items-center gap-3 p-3", i > 0 && "border-t")}
        >
          <span className="w-32 shrink-0 text-sm font-medium">{fmtRelative(r.started_at)}</span>
          {runStatusBadge(r)}
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={r.summary ?? undefined}>
            {r.summary ?? (r.status === "running" ? "In progress…" : "—")}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{duration(r)}</span>
          {w.home_channel_id && r.root_message_id && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onOpenRunThread(w.home_channel_id!, r.root_message_id!)}
              className="h-7 shrink-0 text-xs text-muted-foreground"
            >
              <MessageSquare className="size-3.5" /> Thread
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
