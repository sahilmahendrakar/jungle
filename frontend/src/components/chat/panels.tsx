// Presentational panels/cards for the chat UI, extracted from App.tsx. All are prop-driven
// (no App closure), so they render identically to when they lived inline in App.
import { useState, useEffect, useRef, type ReactNode } from "react";
import {
  Activity,
  Check,
  ChevronDown,
  FileText,
  FoldVertical,
  GitBranch,
  Plus,
  ShieldQuestion,
  Sparkles,
  Trash2,
  X,
  UserRound,
} from "lucide-react";
import { updateAgent, deleteAgent, compactAgent, attachmentUrl } from "../../api";
import type { Attachment, Participant, AgentStatus } from "../../api";
import {
  fmtBytes,
  fmtTokens,
  INLINE_IMAGE_MIMES,
  MODEL_OPTIONS,
  SDK_MODE_OPTIONS,
  STATUS_DOT,
  STATUS_LABEL,
  type ToolConfirm,
} from "../../lib/chat";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { avatarClass, initials } from "@/lib/people";
import { cn } from "@/lib/utils";

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
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string; hint?: string }[];
  testId?: string;
}) {
  const current = options.find((o) => o.id === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" data-testid={testId} className="w-full justify-between font-normal">
          <span className="truncate">{current?.label}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        portal={false}
        align="start"
        className="w-[var(--radix-dropdown-menu-trigger-width)]"
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
}: {
  person: Participant;
  isSelf: boolean;
  onClose: () => void;
  onSaved: (p: Participant) => void;
  onOpenActivity: () => void;
  onDeleted: (id: string) => void;
}) {
  const isAgent = person.kind === "agent";
  const [name, setName] = useState(person.display_name);
  const [mode, setMode] = useState(person.mode ?? "default");
  const [model, setModel] = useState(person.model ?? MODEL_OPTIONS[0].id);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  const dirty =
    name.trim() !== person.display_name ||
    mode !== (person.mode ?? "default") ||
    model !== (person.model ?? MODEL_OPTIONS[0].id);

  async function save() {
    if (!dirty || saving || !name.trim()) return;
    setSaving(true);
    setErr("");
    try {
      const patch: { displayName?: string; mode?: string; model?: string } = {
        displayName: name.trim(),
        mode,
        model,
      };
      const updated = await updateAgent(person.id, patch);
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
              {isAgent && (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  <Sparkles className="size-2.5" /> agent
                </span>
              )}
              {isSelf && <span className="text-xs text-muted-foreground">(you)</span>}
            </div>
            <div className="truncate text-sm text-muted-foreground">@{person.handle}</div>
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
              <Label>Tool permissions</Label>
              <SelectMenu
                value={mode}
                onChange={setMode}
                options={SDK_MODE_OPTIONS}
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
            {person.repo && (
              <div className="min-w-0 space-y-0.5 rounded-lg border bg-muted/30 p-3">
                <div className="text-xs font-medium text-muted-foreground">Repository</div>
                <a
                  href={`https://github.com/${person.repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 truncate text-sm text-primary hover:underline"
                >
                  <GitBranch className="size-3.5 shrink-0" />
                  <span className="truncate">{person.repo}</span>
                </a>
              </div>
            )}
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
export function ContextUsageCard({ person }: { person: Participant }) {
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState(false);
  const [err, setErr] = useState("");

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

  // A fresh usage report (e.g. the compaction turn finishing) supersedes the queued note.
  const updatedAt = person.context_updated_at ?? null;
  const requestedAtRef = useRef<string | null>(null);
  useEffect(() => {
    if (requested && updatedAt !== requestedAtRef.current) setRequested(false);
  }, [updatedAt, requested]);

  async function compact() {
    if (requesting || requested) return;
    setRequesting(true);
    setErr("");
    try {
      const r = await compactAgent(person.id);
      if (!r.ok) throw new Error(r.error === "runner not connected" ? "Agent is offline." : (r.error ?? "compact failed"));
      requestedAtRef.current = updatedAt;
      setRequested(true);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setRequesting(false);
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
      <Button
        variant="outline"
        size="sm"
        data-testid="agent-compact"
        onClick={compact}
        disabled={requesting || requested}
        className="w-full gap-2 text-muted-foreground"
      >
        <FoldVertical className="size-3.5" />
        {requesting ? "Requesting…" : requested ? "Compaction queued" : "Compact context"}
      </Button>
      {requested && (
        <p className="text-[11px] leading-tight text-muted-foreground">
          The agent will summarize its older conversation when it's next idle; the meter
          updates when it finishes.
        </p>
      )}
      {err && <p className="text-[11px] text-destructive">{err}</p>}
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
