import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CalendarClock, Loader2, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useAuth } from "./auth";
import { navigate } from "./route";
import {
  WS_BASE,
  createSchedule,
  deleteSchedule,
  listChannels,
  listParticipants,
  listSchedules,
  updateSchedule,
  type Channel,
  type Participant,
  type Schedule,
} from "./api";
import { fmtRelative } from "./lib/chat";
import { avatarClass, initials } from "./lib/people";
import { cn } from "./lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Human-readable cadence for a schedule row. The raw cron is shown deliberately (no cronstrue
// dependency); paired with the "Next run" relative time it reads unambiguously.
function describeCadence(s: Schedule): string {
  if (s.run_at) {
    return `Once · ${new Date(s.run_at).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  return `cron "${s.cron}" · ${s.timezone}`;
}

const TIMEZONES: string[] = (() => {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (fn) return fn("timeZone");
  } catch {
    /* fall through */
  }
  return ["UTC", "America/Los_Angeles", "America/New_York", "Europe/London", "Asia/Tokyo"];
})();

function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function Scheduled({ workspaceId }: { workspaceId: string }) {
  const { getToken } = useAuth();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [people, setPeople] = useState<Participant[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const agents = useMemo(() => people.filter((p) => p.kind === "agent"), [people]);
  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  const reload = () => listSchedules().then(setSchedules).catch(() => {});

  useEffect(() => {
    let cancelled = false;
    Promise.all([listSchedules(), listParticipants(), listChannels("")])
      .then(([s, p, c]) => {
        if (cancelled) return;
        setSchedules(s);
        setPeople(p);
        setChannels(c.filter((ch) => ch.kind === "channel"));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Live updates: a self-contained socket (the page renders outside <App>, so it can't share
  // App's). Any schedule_changed in this workspace -> refetch the (small) list.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    let stopped = false;
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      const token = (await getToken()) ?? "";
      if (stopped) return;
      ws = new WebSocket(
        `${WS_BASE}/?token=${encodeURIComponent(token)}&workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      ws.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data);
          if (evt?.type === "schedule_changed") reloadRef.current();
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (!stopped) retry = setTimeout(connect, 1500);
      };
    };
    void connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [workspaceId, getToken]);

  async function togglePause(s: Schedule) {
    setBusyId(s.id);
    try {
      await updateSchedule(s.id, { paused: !s.paused_at });
      await reload();
    } catch {
      /* surfaced by refetch staying unchanged */
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Button
          variant="ghost"
          size="icon"
          data-testid="scheduled-back"
          onClick={() => navigate("/")}
          className="size-8 shrink-0"
          aria-label="Back to Jungle"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <CalendarClock className="size-4 text-muted-foreground" />
        <h1 className="text-base font-semibold">Scheduled</h1>
        <div className="ml-auto">
          <Button size="sm" data-testid="new-schedule" onClick={() => setEditing("new")}>
            <Plus className="size-4" /> New schedule
          </Button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        {loading ? (
          <div className="flex justify-center py-12 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : schedules.length === 0 ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            No schedules yet. Create one, or just ask an agent to “remind me every morning at 9”.
          </div>
        ) : (
          <ul className="space-y-2">
            {schedules.map((s) => {
              const agent = peopleById.get(s.agent_id);
              const name = s.agent_name || agent?.display_name || s.agent_handle || "agent";
              const handle = s.agent_handle || agent?.handle || "";
              return (
                <li
                  key={s.id}
                  className="flex items-start gap-3 rounded-xl border bg-card p-3"
                  data-testid="schedule-row"
                >
                  <Avatar className="size-8 shrink-0">
                    <AvatarFallback className={cn("text-xs", avatarClass(handle))}>
                      {initials(name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">@{handle}</span>
                      <span className="text-xs text-muted-foreground">in #{s.channel_name}</span>
                      {s.paused_at && (
                        <Badge variant="secondary" className="text-[10px]">
                          Paused
                        </Badge>
                      )}
                      {s.last_status && (
                        <Badge
                          variant={s.last_status === "failure" ? "destructive" : "outline"}
                          className="text-[10px]"
                          title={s.last_error ?? undefined}
                        >
                          {s.last_status === "failure"
                            ? "Last run failed"
                            : s.last_status === "success"
                              ? "Last run ok"
                              : "Running"}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-foreground/90" title={s.prompt}>
                      {s.prompt}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      <span>{describeCadence(s)}</span>
                      <span>
                        {s.paused_at
                          ? "Paused"
                          : s.next_run_at
                            ? `Next run ${fmtRelative(s.next_run_at)}`
                            : "Completed"}
                      </span>
                      {s.last_run_at && <span>Last run {fmtRelative(s.last_run_at)}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      disabled={busyId === s.id}
                      onClick={() => togglePause(s)}
                      aria-label={s.paused_at ? "Resume" : "Pause"}
                      title={s.paused_at ? "Resume" : "Pause"}
                    >
                      {s.paused_at ? <Play className="size-4" /> : <Pause className="size-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      onClick={() => setEditing(s)}
                      aria-label="Edit"
                      title="Edit"
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-destructive"
                      onClick={() => setDeleting(s)}
                      aria-label="Delete"
                      title="Delete"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {editing && (
        <ScheduleFormDialog
          initial={editing === "new" ? null : editing}
          agents={agents}
          channels={channels}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}

      <DeleteScheduleDialog
        schedule={deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          await deleteSchedule(deleting.id);
          setDeleting(null);
          await reload();
        }}
      />
    </main>
  );
}

function DeleteScheduleDialog({
  schedule,
  onOpenChange,
  onConfirm,
}: {
  schedule: Schedule | null;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  async function confirm() {
    if (deleting) return;
    setDeleting(true);
    try {
      await onConfirm();
    } finally {
      setDeleting(false);
    }
  }
  return (
    <Dialog open={!!schedule} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this schedule?</DialogTitle>
          <DialogDescription>
            This permanently removes the schedule. It won't fire again. This can't be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Convert a stored ISO run_at into the value a <input type="datetime-local"> expects (local,
// no timezone suffix, minute precision), and back.
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ScheduleFormDialog({
  initial,
  agents,
  channels,
  onClose,
  onSaved,
}: {
  initial: Schedule | null;
  agents: Participant[];
  channels: Channel[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const editing = !!initial;
  const [agentId, setAgentId] = useState(initial?.agent_id ?? agents[0]?.id ?? "");
  const [channelId, setChannelId] = useState(initial?.channel_id ?? channels[0]?.id ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [mode, setMode] = useState<"recurring" | "once">(initial?.run_at ? "once" : "recurring");
  const [cron, setCron] = useState(initial?.cron ?? "0 9 * * *");
  const [timezone, setTimezone] = useState(initial?.timezone ?? browserTz());
  const [runAt, setRunAt] = useState(isoToLocalInput(initial?.run_at ?? null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setError("");
    if (!prompt.trim()) return setError("Prompt is required.");
    if (!editing && !agentId) return setError("Pick an agent.");
    if (!channelId) return setError("Pick a channel.");
    const cadence =
      mode === "recurring"
        ? { cron, timezone, runAt: undefined }
        : { cron: undefined, timezone: undefined, runAt: runAt ? new Date(runAt).toISOString() : "" };
    setSaving(true);
    try {
      if (editing && initial) {
        await updateSchedule(initial.id, {
          prompt: prompt.trim(),
          channelId,
          cron: cadence.cron ?? null,
          timezone: cadence.timezone ?? null,
          runAt: cadence.runAt ?? null,
        });
      } else {
        await createSchedule({ agentId, channelId, prompt: prompt.trim(), ...cadence });
      }
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit schedule" : "New schedule"}</DialogTitle>
          <DialogDescription>
            The agent runs this on a cadence with no memory of now — write the prompt as a
            complete, self-contained instruction.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sched-agent">Agent</Label>
              <select
                id="sched-agent"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm disabled:opacity-60"
                value={agentId}
                disabled={editing}
                onChange={(e) => setAgentId(e.target.value)}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    @{a.handle}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sched-channel">Channel</Label>
              <select
                id="sched-channel"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sched-prompt">Prompt</Label>
            <Textarea
              id="sched-prompt"
              rows={4}
              maxLength={4000}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Post a summary of open PRs in #dev, grouped by author."
            />
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={mode === "recurring" ? "default" : "outline"}
              onClick={() => setMode("recurring")}
            >
              Recurring
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "once" ? "default" : "outline"}
              onClick={() => setMode("once")}
            >
              One-time
            </Button>
          </div>

          {mode === "recurring" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="sched-cron">Cron (5-field)</Label>
                <Input
                  id="sched-cron"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="0 9 * * 1-5"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sched-tz">Timezone</Label>
                <select
                  id="sched-tz"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="sched-runat">Run at</Label>
              <Input
                id="sched-runat"
                type="datetime-local"
                value={runAt}
                onChange={(e) => setRunAt(e.target.value)}
              />
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving} data-testid="save-schedule">
            {saving ? "Saving…" : editing ? "Save changes" : "Create schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
