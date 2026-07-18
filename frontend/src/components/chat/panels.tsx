// Presentational panels/cards for the chat UI, extracted from App.tsx. All are prop-driven
// (no App closure), so they render identically to when they lived inline in App.
import { useState, useEffect, useRef, type ReactNode } from "react";
import {
  Activity,
  BookOpenText,
  Check,
  ChevronDown,
  Cloud,
  FileText,
  FoldVertical,
  MonitorSmartphone,
  Plus,
  Server,
  ShieldQuestion,
  Sparkles,
  Trash2,
  X,
  UserRound,
} from "lucide-react";
import {
  updateAgent,
  deleteAgent,
  compactAgent,
  clearAgentContext,
  attachmentUrl,
  getAgentMemory,
  getAgentServices,
  stopAgentService,
  listAgentIntegrations,
  setAgentIntegration,
  removeAgentIntegration,
  listWorkflows,
  updateWorkflow,
  connectionForIntegration,
} from "../../api";
import type { Attachment, Participant, AgentStatus, AgentServiceInfo, Workflow } from "../../api";
import {
  IntegrationsEditor,
  integrationFingerprint,
  integrationsFingerprint,
  validateIntegrations,
  type IntegrationDraft,
} from "./IntegrationsEditor";
import { useConnections, BrandTile } from "@/lib/connections";
import {
  fmtBytes,
  EFFORT_OPTIONS,
  fmtTokens,
  INLINE_IMAGE_MIMES,
  MODEL_OPTIONS,
  sdkModeOptionsFor,
  STATUS_DOT,
  STATUS_LABEL,
  type ToolConfirm,
} from "../../lib/chat";
import { catalogEntry, getIntegrationType } from "@jungle/shared";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "../../Markdown";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { avatarClass, initials } from "@/lib/people";
import { cn } from "@/lib/utils";

// The "✨ agent" pill shown next to agent names (message rows, thread panel, profile).
export function AgentBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
      <Sparkles className="size-2.5" /> agent
    </span>
  );
}

// Centered empty-state tile (icon in a rounded square + hint text) shared by the message list,
// activity transcript, and thread panel.
export function EmptyState({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        {icon}
      </div>
      <p className="max-w-xs text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  return (
    <div data-testid="message-attachments" className="flex flex-wrap items-start gap-2">
      {attachments.map((a) =>
        INLINE_IMAGE_MIMES.has(a.mime) ? (
          <a key={a.id} href={attachmentUrl(a)} target="_blank" rel="noreferrer" className="mt-1.5 block w-fit">
            <img
              src={attachmentUrl(a)}
              alt={a.filename}
              loading="lazy"
              // Intrinsic size hints (when the backend measured them) reduce layout shift.
              width={a.width ?? undefined}
              height={a.height ?? undefined}
              // Slack-style: cap at ~360px wide / 320px tall and let the box shrink to the
              // image. h-auto/w-auto keep the aspect ratio so the intrinsic width/height attrs
              // above don't pin the box to a fixed size (which would letterbox inside a border).
              className="h-auto max-h-80 w-auto max-w-[360px] rounded-lg border object-contain"
            />
          </a>
        ) : (
          <a
            key={a.id}
            href={attachmentUrl(a)}
            target="_blank"
            rel="noreferrer"
            className="mt-1.5 flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2 shadow-sm transition-colors hover:bg-accent"
          >
            <FileText className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block max-w-56 truncate text-sm font-medium">{a.filename}</span>
              <span className="block text-xs text-muted-foreground">{fmtBytes(a.size_bytes)}</span>
            </span>
          </a>
        ),
      )}
    </div>
  );
}

// A shadcn-styled single-select built on the DropdownMenu primitive (portal=false so it
// works inside dialogs). Shows the current option's label; lists options with an optional hint.
export function SelectMenu({
  value,
  onChange,
  options,
  testId,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: ReactNode; hint?: string }[];
  testId?: string;
  disabled?: boolean;
}) {
  const current = options.find((o) => o.id === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="outline"
          data-testid={testId}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{current?.label}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={8}
        className="w-[var(--radix-dropdown-menu-trigger-width)] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto"
      >
        {options.map((o) => (
          <DropdownMenuItem
            key={o.id}
            data-testid={testId ? `${testId}-option` : undefined}
            onClick={() => onChange(o.id)}
            className="flex items-center justify-between gap-3"
          >
            <span className="flex flex-col">
              <span>{o.label}</span>
              {o.hint && <span className="text-xs text-muted-foreground">{o.hint}</span>}
            </span>
            {o.id === value && <Check className="size-4 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- template (draft-workflow seat) vs real agents ---
//
// A "template agent" is referenced by a DRAFT workflow's roster. The roster's integration keys
// are the team's wishlist: keys whose backing user connection wasn't linked at draft time never
// attached (the backend attach is best-effort), so they don't exist as agent_integrations rows.
// Template agents show those as a pending, removable list; removing keeps the roster (and the
// workflow canvas, via the workflow_changed broadcast) in sync. Once the workflow finalizes the
// agent is real: its profile hides integrations whose connection still isn't linked.

// Drop one integration key from every draft roster seat the agent occupies. Returns the updated
// workflow list (same shape it was given), for the panel's local state. This is the PENDING-key
// path (roster-listed but never attached, so there's no agent_integrations row to DELETE) —
// removing an attached row is scrubbed backend-side by the integration DELETE route.
async function scrubKeyFromDraftSeats(
  workflows: Workflow[],
  participantId: string,
  key: string,
): Promise<Workflow[]> {
  const next: Workflow[] = [];
  for (const wf of workflows) {
    if (!wf.roster.some((r) => r.participant_id === participantId && r.integrations.includes(key))) {
      next.push(wf);
      continue;
    }
    const roster = wf.roster.map((r) => {
      if (r.participant_id !== participantId || !r.integrations.includes(key)) return r;
      const n = { ...r, integrations: r.integrations.filter((k) => k !== key) };
      // The repo shorthand only means something alongside the github integration.
      if (key === "github") delete n.repo;
      return n;
    });
    next.push(await updateWorkflow(wf.id, { roster }));
  }
  return next;
}

// Slack-style profile for viewing another participant. Humans are read-only (just their alias
// for now). Agents expose an editable config: display name + tool-permission mode (applied live),
// model (applied at the next turn), and an Activity view.
// (The current user's own settings — email, GitHub, sign out — live at the /settings route.)
export function ParticipantProfilePanel({
  person,
  isSelf,
  onClose,
  onSaved,
  onOpenActivity,
  onDeleted,
  onOpenConnections,
}: {
  person: Participant;
  isSelf: boolean;
  onClose: () => void;
  onSaved: (p: Participant) => void;
  onOpenActivity: () => void;
  onDeleted: (id: string) => void;
  // Opens the user's settings panel on Connections (template agents' pending integrations).
  onOpenConnections?: () => void;
}) {
  const isAgent = person.kind === "agent";
  const [name, setName] = useState(person.display_name);
  const [persona, setPersona] = useState(person.persona ?? "");
  const [mode, setMode] = useState(person.mode ?? "default");
  const [model, setModel] = useState(person.model ?? MODEL_OPTIONS[0].id);
  const [effort, setEffort] = useState(person.effort ?? EFFORT_OPTIONS[1].id);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [integrations, setIntegrations] = useState<IntegrationDraft[]>([]);
  const [origIntegrations, setOrigIntegrations] = useState<IntegrationDraft[]>([]);
  // Draft workflows whose roster seats this agent — non-empty = template agent (see above).
  const [seatWorkflows, setSeatWorkflows] = useState<Workflow[]>([]);
  // The viewer's per-user connections gate the integration rows (inline connect / approval toggle).
  const connections = useConnections(isAgent);

  useEffect(() => {
    if (!isAgent) return;
    let cancelled = false;
    listAgentIntegrations(person.id).then((rows) => {
      if (cancelled) return;
      const draft = rows.map((r) => ({ key: r.integration_key, config: r.config as Record<string, string> }));
      setIntegrations(draft);
      setOrigIntegrations(draft);
    });
    return () => {
      cancelled = true;
    };
  }, [isAgent, person.id]);

  // Track the draft rosters this agent sits on (live — a roster scrub elsewhere, or the
  // workflow finalizing, flips the panel between template and real-agent behavior).
  useEffect(() => {
    if (!isAgent) return;
    let cancelled = false;
    const load = () => {
      listWorkflows()
        .then((wfs) => {
          if (cancelled) return;
          setSeatWorkflows(
            wfs.filter(
              (wf) => wf.status === "draft" && wf.roster.some((r) => r.participant_id === person.id),
            ),
          );
        })
        .catch(() => {});
    };
    load();
    window.addEventListener("jungle:workflow-changed", load);
    return () => {
      cancelled = true;
      window.removeEventListener("jungle:workflow-changed", load);
    };
  }, [isAgent, person.id]);

  const isTemplateAgent = seatWorkflows.length > 0;
  // Roster-listed keys with no attached row — shown pending, removable (scrubs the roster).
  // Keyed off origIntegrations (server truth) so unsaved editor edits don't reshuffle the list.
  const attachedKeys = new Set(origIntegrations.map((v) => v.key));
  const pendingKeys: string[] = [];
  for (const wf of seatWorkflows) {
    for (const r of wf.roster) {
      if (r.participant_id !== person.id) continue;
      for (const k of r.integrations) {
        if (!attachedKeys.has(k) && !pendingKeys.includes(k)) pendingKeys.push(k);
      }
    }
  }

  async function removeTemplateKey(key: string) {
    setErr("");
    try {
      setSeatWorkflows(await scrubKeyFromDraftSeats(seatWorkflows, person.id, key));
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  async function del() {
    if (deleting) return;
    setDeleting(true);
    setErr("");
    try {
      await deleteAgent(person.id);
      onDeleted(person.id);
      onClose();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      setDeleting(false);
    }
  }

  // Integration changes compare canonical fingerprints (editable fields only) — raw JSON
  // compares choked on server-resolved fields vs local string drafts and left the Save button
  // stuck dirty after a successful save.
  const dirty =
    name.trim() !== person.display_name ||
    persona.trim() !== (person.persona ?? "") ||
    mode !== (person.mode ?? "default") ||
    model !== (person.model ?? MODEL_OPTIONS[0].id) ||
    effort !== (person.effort ?? EFFORT_OPTIONS[1].id) ||
    integrationsFingerprint(integrations) !== integrationsFingerprint(origIntegrations);

  async function save() {
    if (!dirty || saving || !name.trim()) return;
    // Surface incomplete integrations (missing connection / repo) before hitting the server,
    // instead of failing halfway through the write sequence.
    const problem = validateIntegrations(integrations, connections);
    if (problem) {
      setErr(problem);
      return;
    }
    setSaving(true);
    setErr("");
    try {
      const patch: {
        displayName?: string;
        mode?: string;
        model?: string;
        effort?: string;
        persona?: string;
      } = {
        displayName: name.trim(),
        mode,
        model,
        effort,
        persona: persona.trim(),
      };
      const nextKeys = new Set(integrations.map((v) => v.key));
      // Removed rows: the backend scrubs the key from every workflow roster the agent sits on
      // (draft or live) and broadcasts workflow_changed, so the canvas + Connections panel stop
      // advertising an integration the agent no longer has. (Pending unattached keys have no row
      // to delete — those scrub via removeTemplateKey's roster PATCH instead.)
      for (const orig of origIntegrations) {
        if (!nextKeys.has(orig.key)) await removeAgentIntegration(person.id, orig.key);
      }
      for (const entry of integrations) {
        const prev = origIntegrations.find((v) => v.key === entry.key);
        if (!prev || integrationFingerprint(prev) !== integrationFingerprint(entry)) {
          await setAgentIntegration(person.id, entry.key, entry.config);
        }
      }
      const updated = await updateAgent(person.id, patch);
      // Reset the editor to server truth (resolved configs) so the dirty check starts clean.
      const rows = await listAgentIntegrations(person.id);
      const draft = rows.map((r) => ({ key: r.integration_key, config: r.config as Record<string, string> }));
      setIntegrations(draft);
      setOrigIntegrations(draft);
      onSaved(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="profile-panel" className="flex h-full flex-col">
      {/* Panel header */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        {isAgent ? (
          <Sparkles className="size-4 text-muted-foreground" />
        ) : (
          <UserRound className="size-4 text-muted-foreground" />
        )}
        <h2 className="min-w-0 flex-1 truncate font-semibold">
          {isSelf ? "Your profile" : isAgent ? "Agent" : "Profile"}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          data-testid="profile-close"
          aria-label="Close profile"
          onClick={onClose}
          className="size-8 shrink-0 text-muted-foreground"
        >
          <X className="size-4" />
        </Button>
      </header>

      {/* Scrollable body */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {/* Identity header */}
        <div className="flex items-center gap-4">
          <Avatar className="size-16 rounded-xl">
            <AvatarFallback className={cn(avatarClass(person.handle), "rounded-xl text-xl")}>
              {initials(person.display_name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-bold">{person.display_name}</h2>
              {isAgent && <AgentBadge />}
              {isSelf && <span className="text-xs text-muted-foreground">(you)</span>}
            </div>
            <div className="truncate text-sm text-muted-foreground">@{person.handle}</div>
            {isAgent && person.status && (
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  data-testid="status-dot"
                  data-status={person.status}
                  className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[person.status])}
                />
                {STATUS_LABEL[person.status]}
              </div>
            )}
          </div>
        </div>

        {isAgent ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="profile-name">Display name</Label>
              <Input
                id="profile-name"
                data-testid="profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-persona">Persona</Label>
              <Textarea
                id="profile-persona"
                data-testid="profile-persona"
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                maxLength={4000}
                rows={4}
                placeholder={
                  "Who is this agent? e.g. \"You are our infra engineer: own the deploy pipeline, " +
                  "prefer boring solutions, keep answers terse.\""
                }
                className="max-h-48 min-h-20 resize-y text-sm"
              />
              <p className="text-[11px] leading-tight text-muted-foreground">
                Shapes the agent's role and voice in its system prompt. Applies at its next turn.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Tool permissions</Label>
              <SelectMenu
                value={mode}
                onChange={setMode}
                options={sdkModeOptionsFor(mode)}
                testId="agent-mode-select"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Model</Label>
              <SelectMenu
                value={model}
                onChange={setModel}
                options={MODEL_OPTIONS}
                testId="agent-model-select"
              />
              <p className="text-[11px] leading-tight text-muted-foreground">
                Applies at the agent's next turn.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Reasoning effort</Label>
              <SelectMenu
                value={effort}
                onChange={setEffort}
                options={EFFORT_OPTIONS}
                testId="agent-effort-select"
                disabled={catalogEntry(model)?.supportsEffort === false}
              />
              <p className="text-[11px] leading-tight text-muted-foreground">
                {catalogEntry(model)?.supportsEffort === false
                  ? "Not supported by this model."
                  : "Lower effort spends fewer tokens. Applies at the agent's next turn."}
              </p>
            </div>
            <IntegrationsEditor
              value={integrations}
              onChange={setIntegrations}
              connections={connections}
              // Real agents only show working integrations; a template agent keeps its
              // not-yet-linked rows visible so they can be connected (or removed) pre-launch.
              hideUnconnected={!isTemplateAgent}
            />
            {isTemplateAgent && pendingKeys.length > 0 && (
              <div className="space-y-1.5" data-testid="template-pending-integrations">
                <Label className="text-muted-foreground">Not connected yet</Label>
                {pendingKeys.map((k) => {
                  const connType = connectionForIntegration(k);
                  const conn = connType ? connections.byKey[connType.key] : undefined;
                  const linked = !!conn?.connected;
                  return (
                    <div
                      key={k}
                      className="group flex items-center gap-2.5 rounded-lg border border-amber-400/50 bg-amber-50/40 pr-1.5 dark:bg-amber-500/5"
                      data-testid={`template-pending-${k}`}
                    >
                      <button
                        type="button"
                        onClick={onOpenConnections ? () => onOpenConnections() : undefined}
                        title="Open your connections settings"
                        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-l-lg py-2 pl-2.5 text-left hover:bg-accent/40"
                      >
                        <BrandTile brand={k} className="size-7 rounded-md" glyphClassName="size-3.5" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium leading-tight">
                            {getIntegrationType(k)?.name ?? k}
                          </span>
                          <span
                            className={cn(
                              "block truncate text-[11px] leading-tight",
                              linked ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
                            )}
                          >
                            {linked
                              ? "Account linked — attaches when the workflow is created"
                              : "Not connected — link it in your settings"}
                          </span>
                        </span>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => void removeTemplateKey(k)}
                        data-testid={`template-pending-remove-${k}`}
                        aria-label={`Remove ${getIntegrationType(k)?.name ?? k}`}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  );
                })}
                <p className="text-[11px] leading-tight text-muted-foreground">
                  The workflow template expects these. Connect them in your settings, or remove
                  them from the agent — the canvas updates either way.
                </p>
              </div>
            )}
            <EnvironmentCard person={person} />
            <ServicesCard person={person} />
            <MemoryCard person={person} />
            <ContextUsageCard person={person} />
            <Button
              variant="outline"
              data-testid="activity-open"
              onClick={onOpenActivity}
              className="w-full justify-start gap-2 text-muted-foreground"
            >
              <Activity className="size-4" />
              View activity
            </Button>
            {err && <p className="text-sm text-destructive">{err}</p>}
            {/* Danger zone: permanently delete this agent. */}
            {!isSelf && (
              <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                {!confirmDelete ? (
                  <Button
                    variant="ghost"
                    data-testid="agent-delete"
                    onClick={() => setConfirmDelete(true)}
                    className="w-full justify-start gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                    Delete agent
                  </Button>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Permanently delete <span className="font-medium">{person.display_name}</span>,
                      its container, your DM, and every message it sent. This can't be undone.
                    </p>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDelete(false)}
                        disabled={deleting}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        data-testid="agent-delete-confirm"
                        onClick={del}
                        disabled={deleting}
                      >
                        {deleting ? "Deleting…" : "Delete agent"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
            {isSelf
              ? "This is how you appear to everyone in the workspace."
              : `${person.display_name} is a member of the workspace.`}
          </div>
        )}
      </div>

      {/* Sticky footer: save controls (agent config only) */}
      {isAgent && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
          {saved && (
            <span className="mr-auto flex items-center gap-1 text-sm text-emerald-600">
              <Check className="size-4" /> Saved
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            data-testid="profile-save"
            onClick={save}
            disabled={!dirty || saving || !name.trim()}
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
    </div>
  );
}

// Compact token counts for the context meter: 76200 -> "76.2k", 1000000 -> "1M".
// Context-window occupancy + compaction control in an agent's profile. `person` is the live
// row from `people`, so the meter updates in place whenever an `agent_context` broadcast
// lands — including the one the runner sends after a requested compaction finishes.
// Where this agent runs: a cloud sandbox, or one of the creator's own devices (self-hosted). For a
// self-hosted agent we show the host details the runner reported (runner_meta.host) + which device.
export function EnvironmentCard({ person }: { person: Participant }) {
  const selfHosted = person.runner_provider === "self_hosted";
  const host = (person.runner_meta as { host?: { hostname?: string; platform?: string; arch?: string } } | null)?.host;
  const offline = person.status === "offline";
  return (
    <div data-testid="environment-card" className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
      <div className="text-xs font-medium text-muted-foreground">Environment</div>
      <div className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
          {selfHosted ? <MonitorSmartphone className="size-3.5 text-primary" /> : <Cloud className="size-3.5 text-primary" />}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {selfHosted ? host?.hostname ?? "Your device" : "Cloud sandbox"}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {selfHosted
              ? [host?.platform && host?.arch ? `${host.platform}/${host.arch}` : host?.platform, offline ? "offline" : null]
                  .filter(Boolean)
                  .join(" · ") || "self-hosted"
              : "managed by Jungle"}
          </div>
        </div>
      </div>
      {selfHosted && offline && (
        <p className="text-[11px] leading-tight text-muted-foreground">
          This agent's device is offline — messages queue until it reconnects.
        </p>
      )}
    </div>
  );
}

export function ContextUsageCard({ person }: { person: Participant }) {
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState(false);
  const [waking, setWaking] = useState(false);
  const [err, setErr] = useState("");

  // Clear-context (Claude Code's /clear): drops the conversation, keeps memory. Destructive, so
  // the button arms on first click and fires on the second (disarms after a few seconds).
  const [clearing, setClearing] = useState(false);
  const [clearRequested, setClearRequested] = useState(false);
  const [clearWaking, setClearWaking] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const armedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (armedTimer.current) clearTimeout(armedTimer.current);
  }, []);

  const tokens = person.context_tokens ?? null;
  const max = person.context_max_tokens ?? null;
  const pct =
    tokens != null && max != null && max > 0
      ? Math.min(100, Math.max(0, (tokens / max) * 100))
      : null;

  // Green until the window starts getting tight, then amber, then red — the same read as a
  // fuel gauge. Compaction is most useful in the amber/red range.
  const tone =
    pct == null ? null : pct >= 90 ? "critical" : pct >= 70 ? "warn" : "ok";
  const barColor =
    tone === "critical" ? "bg-red-500" : tone === "warn" ? "bg-amber-500" : "bg-emerald-500";
  const pctColor =
    tone === "critical"
      ? "text-red-600 dark:text-red-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-muted-foreground";

  // A fresh usage report (e.g. the compaction turn finishing, or a clear dropping it to 0)
  // supersedes the queued note for whichever action was requested.
  const updatedAt = person.context_updated_at ?? null;
  const compactRequestedAtRef = useRef<string | null>(null);
  const clearRequestedAtRef = useRef<string | null>(null);
  useEffect(() => {
    if (requested && updatedAt !== compactRequestedAtRef.current) {
      setRequested(false);
      setWaking(false);
    }
  }, [updatedAt, requested]);
  useEffect(() => {
    if (clearRequested && updatedAt !== clearRequestedAtRef.current) {
      setClearRequested(false);
      setClearWaking(false);
    }
  }, [updatedAt, clearRequested]);

  async function compact() {
    if (requesting || requested) return;
    setRequesting(true);
    setErr("");
    try {
      const r = await compactAgent(person.id);
      if (!r.ok) throw new Error(r.error ?? "compact failed");
      compactRequestedAtRef.current = updatedAt;
      setRequested(true);
      setWaking(!!r.waking);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setRequesting(false);
    }
  }

  function armClear() {
    if (clearing || clearRequested) return;
    setClearArmed(true);
    if (armedTimer.current) clearTimeout(armedTimer.current);
    armedTimer.current = setTimeout(() => setClearArmed(false), 4_000);
  }

  async function clear() {
    if (clearing || clearRequested) return;
    setClearing(true);
    setErr("");
    setClearArmed(false);
    if (armedTimer.current) clearTimeout(armedTimer.current);
    try {
      const r = await clearAgentContext(person.id);
      if (!r.ok) throw new Error(r.error ?? "clear failed");
      clearRequestedAtRef.current = updatedAt;
      setClearRequested(true);
      setClearWaking(!!r.waking);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setClearing(false);
    }
  }

  return (
    <div data-testid="context-usage" className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground">Context window</div>
        {pct != null && (
          <span className={cn("text-xs font-semibold tabular-nums", pctColor)}>
            {Math.round(pct)}% full
          </span>
        )}
      </div>
      {pct != null ? (
        <>
          <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
            <div
              className={cn("h-full rounded-full transition-[width] duration-500", barColor)}
              // Keep a sliver visible at very low usage so the meter reads as "working".
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </div>
          <div className="text-[11px] tabular-nums text-muted-foreground">
            {fmtTokens(tokens!)} of {fmtTokens(max!)} tokens
          </div>
        </>
      ) : (
        <p className="text-[11px] leading-tight text-muted-foreground">
          No usage reported yet — updates after the agent's next turn.
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          data-testid="agent-compact"
          onClick={compact}
          disabled={requesting || requested}
          className="flex-1 gap-2 text-muted-foreground"
        >
          <FoldVertical className="size-3.5" />
          {requesting ? "Requesting…" : requested ? "Compaction queued" : "Compact context"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-testid="agent-clear"
          onClick={clearArmed ? clear : armClear}
          disabled={clearing || clearRequested}
          className={cn(
            "flex-1 gap-2",
            clearArmed
              ? "border-destructive text-destructive hover:bg-destructive/10"
              : "text-muted-foreground",
          )}
        >
          <Trash2 className="size-3.5" />
          {clearing
            ? "Requesting…"
            : clearRequested
              ? "Clear queued"
              : clearArmed
                ? "Confirm clear"
                : "Clear context"}
        </Button>
      </div>
      {clearArmed && (
        <p className="text-[11px] leading-tight text-destructive">
          Clears the conversation (memory is kept). Click again to confirm.
        </p>
      )}
      {requested && (
        <p className="text-[11px] leading-tight text-muted-foreground">
          {waking
            ? "The agent was asleep — waking its machine, then it'll summarize its older " +
              "conversation; the meter updates when it finishes."
            : "The agent will summarize its older conversation when it's next idle; the meter " +
              "updates when it finishes."}
        </p>
      )}
      {clearRequested && (
        <p className="text-[11px] leading-tight text-muted-foreground">
          {clearWaking
            ? "The agent was asleep — waking its machine, then it'll clear its conversation; " +
              "the meter drops to 0% when it finishes."
            : "The agent will clear its conversation when it's next idle; the meter drops to " +
              "0% when it finishes."}
        </p>
      )}
      {err && <p className="text-[11px] text-destructive">{err}</p>}
    </div>
  );
}

// Read-only view of the agent's long-term memory (its /workspace/MEMORY.md, mirrored to the
// backend after any turn that changes it). Collapsed by default; fetched on expand and
// refetched when an agent_memory_changed broadcast stamps person.memory_changed_at.
export function MemoryCard({ person }: { person: Participant }) {
  const [open, setOpen] = useState(false);
  const [memory, setMemory] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");

  const changedAt = person.memory_changed_at ?? null;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getAgentMemory(person.id)
      .then((r) => {
        if (cancelled) return;
        setMemory(r.memory);
        setUpdatedAt(r.updatedAt);
        setLoaded(true);
        setErr("");
      })
      .catch((e) => !cancelled && setErr(String((e as Error).message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [open, person.id, changedAt]);

  return (
    <div data-testid="agent-memory" className="rounded-lg border bg-muted/30">
      <button
        onClick={() => setOpen((o) => !o)}
        data-testid="agent-memory-toggle"
        className="flex w-full items-center gap-2 p-3 text-left"
      >
        <BookOpenText className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-xs font-medium text-muted-foreground">Memory</span>
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 pb-3 pt-2">
          {err ? (
            <p className="text-[11px] text-destructive">{err}</p>
          ) : !loaded ? (
            <p className="text-[11px] text-muted-foreground">Loading…</p>
          ) : memory ? (
            <>
              <div className="max-h-72 overflow-y-auto rounded-md border bg-background/70 p-2.5">
                <Markdown>{memory}</Markdown>
              </div>
              {updatedAt && (
                <p className="text-[11px] text-muted-foreground">
                  Updated {new Date(updatedAt).toLocaleString()}
                </p>
              )}
            </>
          ) : (
            <p className="text-[11px] leading-tight text-muted-foreground">
              No memories yet — the agent writes down durable facts (preferences, decisions,
              gotchas) as it works with you.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// The agent's managed services (service_* tools: dev servers, watchers, tunnels), with a stop
// button per running service. Collapsed by default; fetched on expand and refetched when an
// agent_services_changed broadcast stamps person.services_changed_at (same pattern as Memory).
export function ServicesCard({ person }: { person: Participant }) {
  const [open, setOpen] = useState(false);
  const [services, setServices] = useState<AgentServiceInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [stopping, setStopping] = useState<string | null>(null);

  const changedAt = person.services_changed_at ?? null;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getAgentServices(person.id)
      .then((r) => {
        if (cancelled) return;
        setServices(r.services);
        setLoaded(true);
        setErr("");
        setStopping(null); // the post-stop refetch — clear the spinner state
      })
      .catch((e) => !cancelled && setErr(String((e as Error).message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [open, person.id, changedAt]);

  const stop = async (name: string) => {
    setStopping(name);
    try {
      await stopAgentService(person.id, name);
      // The fresh list arrives via the agent_services_changed broadcast (changedAt bump).
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      setStopping(null);
    }
  };

  const running = services.filter((s) => s.status === "running").length;
  return (
    <div data-testid="agent-services" className="rounded-lg border bg-muted/30">
      <button
        onClick={() => setOpen((o) => !o)}
        data-testid="agent-services-toggle"
        className="flex w-full items-center gap-2 p-3 text-left"
      >
        <Server className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-xs font-medium text-muted-foreground">Services</span>
        {running > 0 && (
          <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
            {running} running
          </span>
        )}
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 pb-3 pt-2">
          {err && <p className="text-[11px] text-destructive">{err}</p>}
          {!loaded && !err ? (
            <p className="text-[11px] text-muted-foreground">Loading…</p>
          ) : services.length ? (
            services.map((s) => (
              <div
                key={s.name}
                data-testid={`agent-service-${s.name}`}
                className="rounded-md border bg-background/70 p-2"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      s.status === "running" ? "bg-emerald-500" : "bg-muted-foreground/40",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{s.name}</span>
                  {s.status === "running" ? (
                    <button
                      onClick={() => stop(s.name)}
                      disabled={stopping === s.name}
                      data-testid={`agent-service-stop-${s.name}`}
                      className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted disabled:opacity-50"
                    >
                      {stopping === s.name ? "Stopping…" : "Stop"}
                    </button>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">
                      exited{s.exitCode != null ? ` (${s.exitCode})` : ""}
                    </span>
                  )}
                </div>
                <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={s.command}>
                  $ {s.command}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {s.status === "running"
                    ? `up since ${new Date(s.startedAt).toLocaleString()}`
                    : s.exitedAt
                      ? `exited ${new Date(s.exitedAt).toLocaleString()}`
                      : ""}
                </p>
              </div>
            ))
          ) : (
            <p className="text-[11px] leading-tight text-muted-foreground">
              No services — long-running processes the agent starts (dev servers, watchers)
              appear here.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// A pending tool-call confirmation card (always_ask agents). Approve/deny buttons resolve it.
export function ConfirmCard({
  c,
  onDecide,
}: {
  c: ToolConfirm;
  onDecide: (c: ToolConfirm, d: "allow" | "deny") => void;
}) {
  const summary =
    typeof c.input === "string" ? c.input : JSON.stringify(c.input, null, 2);
  return (
    <div
      data-testid="tool-confirm-card"
      className="rounded-xl border border-amber-300/60 bg-amber-50/60 p-3 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/5"
    >
      <div className="flex items-start gap-2.5">
        <ShieldQuestion className="mt-0.5 size-5 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <div className="text-sm">
            <span className="font-semibold">{c.agentName}</span> wants to run{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{c.tool}</code>
          </div>
          {summary && summary !== "{}" && (
            <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg border bg-background/70 p-2 text-[11px] leading-relaxed">
              {summary}
            </pre>
          )}
          <div className="mt-2.5 flex gap-2">
            <Button
              size="sm"
              data-testid="tool-confirm-allow"
              onClick={() => onDecide(c, "allow")}
              className="h-8"
            >
              <Check className="size-4" /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="tool-confirm-deny"
              onClick={() => onDecide(c, "deny")}
              className="h-8"
            >
              <X className="size-4" /> Deny
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SectionHeader({
  label,
  actionLabel,
  onAction,
  actionTestId,
}: {
  label: string;
  actionLabel?: string;
  onAction?: () => void;
  actionTestId?: string;
}) {
  return (
    <div className="flex items-center justify-between px-2 pb-1 pt-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-sidebar-foreground/50">
        {label}
      </span>
      {onAction && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              data-testid={actionTestId}
              onClick={onAction}
              className="flex size-5 items-center justify-center rounded text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <Plus className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{actionLabel}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function NavItem({
  testId,
  active,
  onClick,
  icon,
  label,
  trailing,
  status,
  working,
  title,
  unread,
  badgeCount,
  badgeMention,
}: {
  testId: string;
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  status?: AgentStatus; // agent presence dot (always shown for agents, incl. idle)
  working?: boolean; // a turn is currently running here -> pulsing green dot (channels)
  title?: string;
  unread?: boolean; // has unread messages -> bold + brighter (Slack)
  badgeCount?: number; // when > 0, show a count pill (DMs + mention-containing unreads)
  badgeMention?: boolean; // the unread includes a mention of me (badge is always shown for these)
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      title={title}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground"
          : unread
            ? "font-semibold text-sidebar-foreground hover:bg-sidebar-accent/60"
            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {working && (
        <span
          data-testid="channel-working-dot"
          title="An agent is working here"
          className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
        />
      )}
      {status && (
        <span
          data-testid="status-dot"
          data-status={status}
          title={STATUS_LABEL[status]}
          className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])}
        />
      )}
      {(badgeCount ?? 0) > 0 && (
        <span
          data-testid="unread-badge"
          data-mention={badgeMention ? "true" : undefined}
          className="ml-1 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground"
        >
          {(badgeCount ?? 0) > 99 ? "99+" : badgeCount}
        </span>
      )}
      {trailing}
    </button>
  );
}

export function PersonAvatar({
  name,
  handle,
  size = "md",
}: {
  name: string;
  handle: string;
  size?: "sm" | "md";
}) {
  return (
    <Avatar className={size === "sm" ? "size-5 rounded" : "size-8 rounded-md"}>
      <AvatarFallback
        className={cn(
          avatarClass(handle),
          size === "sm" ? "rounded text-[9px]" : "rounded-md text-xs",
        )}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-1 text-xs text-sidebar-foreground/40">{children}</div>
  );
}
