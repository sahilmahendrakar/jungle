import { useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  Check,
  Loader2,
  MessageSquare,
  Plus,
  Sparkles,
  Workflow as WorkflowIcon,
  Zap,
} from "lucide-react";
import type { Workflow, WorkflowTrigger } from "./api";
import {
  addWorkflowSeat,
  deleteWorkflow,
  finalizeWorkflow,
  getWorkflow,
  removeWorkflowSeat,
  updateWorkflow,
} from "./api";
import { getIntegrationType } from "@jungle/shared";
import { ViewShell } from "./components/chat/ViewShell";
import {
  ConnectionsPanel,
  WorkflowCanvas,
  connectedIntegrationKeys,
  rosterIntegrationKeys,
} from "./components/workflow/WorkflowCanvas";
import { useConnections } from "./lib/connections";
import { navigate } from "./route";
import { DeleteWorkflowDialog } from "./components/workflow/DeleteWorkflowDialog";
import { UnconnectedIntegrationsDialog } from "./components/workflow/UnconnectedIntegrationsDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn, browserTz } from "@/lib/utils";

// The visual create/edit page for a workflow. A workflow is just existing Jungle pieces put
// together — a trigger (schedule), a team of agents (with personas + integrations), and a
// channel — plus one net-new thing, the playbook. The canvas IS the workflow: clicking an agent
// opens the app's real right-side profile panel (instructions, model, integrations with their
// connect flows — same panel as everywhere else). "Create workflow" finalizes the draft
// (provisions the agents, makes the channel, arms the trigger).

// ---- trigger editor ----

const WEEKDAY_CRON = "0 9 * * 1-5";

// A tiny, friendly cron builder for the common cases (daily / weekdays at a time).
function TriggerEditor({
  trigger,
  onChange,
}: {
  trigger: WorkflowTrigger;
  onChange: (t: WorkflowTrigger) => void;
}) {
  const kind = trigger.type;
  const cron = trigger.type === "schedule" ? trigger.cron : WEEKDAY_CRON;
  const tz = trigger.type === "schedule" ? trigger.timezone : browserTz();

  // Parse "M H * * D" into a friendly {hour, days} when it fits the simple shape.
  const parts = cron.split(" ");
  const simple = parts.length === 5 && parts[2] === "*" && parts[3] === "*" && /^\d+$/.test(parts[1]);
  const hour = simple ? Number(parts[1]) : 9;
  const days = parts[4]; // "1-5" | "*" | "0,6" ...

  const setCron = (c: string) => onChange({ type: "schedule", cron: c, timezone: tz });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(
          [
            { k: "schedule", label: "On a schedule", icon: CalendarClock },
            { k: "channel_message", label: "From a message", icon: MessageSquare },
            { k: "manual", label: "Only when I run it", icon: Zap },
          ] as const
        ).map(({ k, label, icon: Icon }) => (
          <button
            key={k}
            onClick={() =>
              onChange(k === "schedule" ? { type: "schedule", cron: WEEKDAY_CRON, timezone: browserTz() } : { type: k })
            }
            className={cn(
              "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
              kind === k ? "border-primary bg-primary/10 text-primary" : "hover:bg-accent",
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>

      {kind === "schedule" && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Run</span>
          <select
            data-testid="trigger-days"
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={days === "1-5" ? "1-5" : days === "*" ? "*" : "custom"}
            onChange={(e) => {
              if (e.target.value === "custom") return;
              setCron(`0 ${hour} * * ${e.target.value}`);
            }}
          >
            <option value="1-5">every weekday</option>
            <option value="*">every day</option>
            <option value="custom">custom…</option>
          </select>
          <span className="text-muted-foreground">at</span>
          <select
            data-testid="trigger-hour"
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={hour}
            onChange={(e) => setCron(`0 ${e.target.value} * * ${days}`)}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">({tz.split("/").pop()?.replace(/_/g, " ")})</span>
        </div>
      )}
      {kind === "channel_message" && (
        <p className="text-xs text-muted-foreground">
          A run starts when someone @mentions the first agent in the workflow's channel. Good for
          "hey team, handle this" moments.
        </p>
      )}
      {kind === "manual" && (
        <p className="text-xs text-muted-foreground">Runs only when you press Run — no automatic trigger.</p>
      )}
    </div>
  );
}

// ---- the page ----

export function WorkflowBuilder({
  workflowId,
  participants,
  sidebarOpen,
  onOpenDrawer,
  onExpandSidebar,
  onOpenAgent,
  onOpenConnections,
  onParticipantsChanged,
}: {
  workflowId: string;
  participants: Parameters<typeof WorkflowCanvas>[0]["participants"];
  sidebarOpen: boolean;
  onOpenDrawer: () => void;
  onExpandSidebar: () => void;
  onOpenAgent: (id: string) => void; // opens the app's right-side profile panel
  onOpenConnections: () => void; // opens the user's settings panel on the Connections section
  onParticipantsChanged: () => void; // seat agents are created server-side; ask App to refetch
}) {
  const [w, setW] = useState<Workflow | null>(null);
  const [name, setName] = useState("");
  const [playbook, setPlaybook] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [warnUnconnected, setWarnUnconnected] = useState(false);

  const connections = useConnections(true);
  const connectedKeys = useMemo(() => connectedIntegrationKeys(connections.connections), [connections.connections]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void getWorkflow(workflowId).then((wf) => {
        if (!alive) return;
        setW(wf);
        setName((n) => (n ? n : wf.name));
        setPlaybook((p) => (p ? p : wf.playbook));
      }).catch(() => alive && setW(null));
    };
    load();
    // The draft's seat agents were just created server-side — pull them into App's list so
    // clicking a node can open its real profile panel.
    onParticipantsChanged();
    window.addEventListener("jungle:workflow-changed", load);
    return () => {
      alive = false;
      window.removeEventListener("jungle:workflow-changed", load);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  if (!w) {
    return (
      <ViewShell icon={<WorkflowIcon className="size-5" />} title="Workflow" sidebarOpen={sidebarOpen} onOpenDrawer={onOpenDrawer} onExpandSidebar={onExpandSidebar} testId="workflow-builder">
        <div className="flex justify-center py-12 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
      </ViewShell>
    );
  }

  const isDraft = w.status === "draft";
  // Pre-flight: which integrations the team uses but the user hasn't linked yet. A warning, not
  // a gate — connections can be linked after launch too (finalize re-attempts the attach).
  const missing = rosterIntegrationKeys(w.roster).filter((k) => !connectedKeys.has(k));

  async function persist(patch: Parameters<typeof updateWorkflow>[1]) {
    try {
      await updateWorkflow(w!.id, patch);
      window.dispatchEvent(new CustomEvent("jungle:workflow-changed"));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function selectAgent(id: string) {
    setSelectedId(id);
    onOpenAgent(id);
  }

  async function addAgent() {
    setBusy(true);
    try {
      const updated = await addWorkflowSeat(w!.id);
      setW(updated);
      onParticipantsChanged();
      const newSeat = updated.roster[updated.roster.length - 1];
      if (newSeat.participant_id) selectAgent(newSeat.participant_id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeAgent(participantId: string) {
    setBusy(true);
    try {
      const updated = await removeWorkflowSeat(w!.id, participantId);
      setW(updated);
      onParticipantsChanged();
      if (selectedId === participantId) setSelectedId(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Gate the create click on the unconnected-integrations warning; the dialog's "Create
  // anyway" (or a clean pre-flight) falls through to the real create.
  function maybeCreate() {
    if (missing.length > 0) {
      setWarnUnconnected(true);
      return;
    }
    void create();
  }

  async function create() {
    setCreating(true);
    setError(null);
    try {
      await updateWorkflow(w!.id, { name, playbook });
      await finalizeWorkflow(w!.id);
      navigate(`/workflows/${w!.id}`);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  return (
    <ViewShell
      icon={<WorkflowIcon className="size-5" />}
      title={isDraft ? "New workflow" : `Edit ${w.name}`}
      sidebarOpen={sidebarOpen}
      onOpenDrawer={onOpenDrawer}
      onExpandSidebar={onExpandSidebar}
      testId="workflow-builder"
    >
      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => navigate("/workflows")} className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          ← Workflows
        </button>
        <div className="ml-auto flex items-center gap-2">
          {isDraft && (
            <Button
              variant="ghost"
              size="sm"
              disabled={creating}
              data-testid="discard-draft"
              onClick={() => setDiscarding(true)}
              className="text-muted-foreground"
            >
              Discard
            </Button>
          )}
          {isDraft ? (
            <Button data-testid="create-workflow" disabled={creating || w.roster.length === 0} onClick={maybeCreate}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {creating ? "Creating team…" : "Create workflow"}
            </Button>
          ) : (
            <Button data-testid="done-editing" onClick={() => navigate(`/workflows/${w!.id}`)}>
              <Check className="size-4" /> Done
            </Button>
          )}
        </div>
      </div>

      {error && <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      <div className="space-y-6">
        {/* Name */}
        <Input
          data-testid="workflow-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== w.name && persist({ name: name.trim() })}
          placeholder="Name this workflow"
          className="h-11 border-0 border-b border-border px-0 text-lg font-semibold shadow-none focus-visible:ring-0"
        />

        {/* The team, as it will run */}
        <section>
          <div className="mb-2 flex items-center px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Team</h2>
            <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">
              click an agent to edit its instructions &amp; connections · hover to peek
            </span>
            {isDraft && (
              <Button size="sm" variant="outline" data-testid="add-agent" disabled={busy} onClick={addAgent} className="ml-auto h-7 text-xs">
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                Add agent
              </Button>
            )}
          </div>
          <WorkflowCanvas
            w={w}
            participants={participants}
            connectedKeys={connectedKeys}
            selectedId={selectedId}
            onSelectAgent={selectAgent}
            onOpenConnections={onOpenConnections}
            edit={
              isDraft
                ? {
                    onRemoveAgent: (id) => void removeAgent(id),
                    onRoleTitle: (i, title) => {
                      const roster = w.roster.map((r, idx) => (idx === i ? { ...r, role: title } : r));
                      setW({ ...w, roster });
                      void persist({ roster });
                    },
                  }
                : undefined
            }
          />
          {missing.length > 0 && (
            <p data-testid="preflight-warning" className="mt-2 flex items-center gap-1.5 px-1 text-xs text-amber-600 dark:text-amber-400">
              <span className="size-1.5 rounded-full bg-amber-500" />
              {missing.map((k) => getIntegrationType(k)?.name ?? k).join(", ")}{" "}
              {missing.length === 1 ? "isn't" : "aren't"} connected yet — the team can't use{" "}
              {missing.length === 1 ? "it" : "them"} until you connect. Click any integration to
              open your connections settings.
            </p>
          )}
        </section>

        {/* Trigger + connections, side by side */}
        <div className="grid gap-6 lg:grid-cols-2">
          <section>
            <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Trigger</h2>
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <TriggerEditor trigger={w.trigger} onChange={(t) => { setW({ ...w, trigger: t }); void persist({ trigger: t }); }} />
            </div>
          </section>
          <section>
            <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Connections</h2>
            <ConnectionsPanel w={w} connectedKeys={connectedKeys} onOpenConnections={onOpenConnections} />
          </section>
        </div>

        {/* Playbook — the one net-new thing; make it feel like a document */}
        <section>
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Playbook</h2>
          <div className="rounded-xl border bg-card shadow-sm">
            <div className="flex items-center gap-2 border-b px-4 py-2.5">
              <WorkflowIcon className="size-3.5 text-primary" />
              <span className="text-xs font-medium text-muted-foreground">
                How the team works a run — every agent reads this
              </span>
            </div>
            <Textarea
              data-testid="workflow-playbook"
              value={playbook}
              onChange={(e) => setPlaybook(e.target.value)}
              onBlur={() => playbook !== w.playbook && persist({ playbook })}
              rows={8}
              placeholder="e.g. Scout scans the inbox and files bugs. The manager assigns each to a fixer. Fixers open PRs and report back. When every bug has a PR, the manager posts 'Run complete:' with a summary."
              className="min-h-[180px] resize-y border-0 bg-transparent px-4 py-3 text-sm leading-relaxed shadow-none focus-visible:ring-0"
            />
          </div>
        </section>
      </div>
      <DeleteWorkflowDialog
        workflow={discarding ? w : null}
        onOpenChange={setDiscarding}
        onConfirm={async () => {
          await deleteWorkflow(w.id);
          onParticipantsChanged();
          navigate("/workflows");
        }}
      />
      <UnconnectedIntegrationsDialog
        missing={warnUnconnected ? missing : null}
        creating={creating}
        onOpenChange={setWarnUnconnected}
        onOpenConnections={onOpenConnections}
        onConfirm={() => {
          setWarnUnconnected(false);
          void create();
        }}
      />
    </ViewShell>
  );
}
