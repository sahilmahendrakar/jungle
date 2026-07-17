import { useEffect, useState } from "react";
import { CalendarClock, Check, Home as HomeIcon, MessageSquare, Package, Radio } from "lucide-react";
import type { Channel, Participant, Deliverable, Schedule, Workflow } from "./api";
import { listSchedules, listWorkflows } from "./api";
import { fmtRelative, type ToolConfirm } from "./lib/chat";
import { ViewShell } from "./components/chat/ViewShell";
import { ApprovalCard } from "./Approvals";
import { DeliverableRow } from "./Deliverables";
import { PersonAvatar } from "./components/chat/panels";
import { navigate } from "./route";

// Home: the attention inbox. One page that answers "what needs me?" (approvals, stalled runs),
// "what happened while I was away?" (deliverables), "what's happening now?" (working agents),
// and "what's coming?" (next scheduled/workflow runs). It absorbs the old Approvals /
// Deliverables / Scheduled nav destinations — those routes still exist as deep links, but the
// daily loop is: open Home, clear the badge, get back to work.

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

// "Tomorrow 8:00 AM" / "Mon 7:30 AM" / "Today 4:00 PM" for an upcoming fire time.
function fmtUpcoming(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = now.toDateString() === d.toDateString();
  const tomorrow = new Date(now.getTime() + 86_400_000).toDateString() === d.toDateString();
  if (today) return `Today ${time}`;
  if (tomorrow) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

export function Home({
  me,
  confirms,
  channels,
  participants,
  deliverables,
  totalThreadUnread,
  onOpenThreads,
  sidebarOpen,
  onOpenDrawer,
  onExpandSidebar,
  onDecide,
  onJumpToChannel,
  onJumpToMessage,
  onOpenAgentProfile,
}: {
  me: Participant | undefined;
  confirms: ToolConfirm[];
  channels: Channel[];
  participants: Participant[];
  deliverables: Deliverable[];
  totalThreadUnread: number;
  onOpenThreads: () => void;
  sidebarOpen: boolean;
  onOpenDrawer: () => void;
  onExpandSidebar: () => void;
  onDecide: (c: ToolConfirm, d: "allow" | "deny") => void;
  onJumpToChannel: (channelId: string) => void;
  onJumpToMessage: (channelId: string, messageId: string) => void;
  onOpenAgentProfile: (id: string) => void;
}) {
  const byChannel = new Map(channels.map((c) => [c.id, c]));
  const working = participants.filter((p) => p.kind === "agent" && p.status === "working");

  // Coming up (next fires) + stalled runs. Self-fetched (coarse, refetch on the relayed
  // schedule/workflow change events) — App doesn't need to own this state.
  const [upcoming, setUpcoming] = useState<{ label: string; at: string; workflowId?: string }[]>([]);
  const [stalled, setStalled] = useState<Workflow[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void Promise.allSettled([listSchedules(), listWorkflows()]).then(([s, w]) => {
        if (!alive) return;
        const items: { label: string; at: string; workflowId?: string }[] = [];
        if (s.status === "fulfilled") {
          for (const sch of s.value) {
            if (sch.next_run_at && !sch.paused_at) {
              items.push({ label: sch.prompt.length > 60 ? sch.prompt.slice(0, 59) + "…" : sch.prompt, at: sch.next_run_at });
            }
          }
        }
        if (w.status === "fulfilled") {
          const wfs = w.value as Workflow[];
          for (const wf of wfs) {
            if (wf.status === "active" && wf.next_run_at) {
              items.push({ label: wf.name, at: wf.next_run_at, workflowId: wf.id });
            }
          }
          setStalled(wfs.filter((wf) => wf.last_run?.status === "stalled"));
        }
        items.sort((a, b) => a.at.localeCompare(b.at));
        setUpcoming(items.slice(0, 5));
      });
    };
    load();
    window.addEventListener("jungle:schedule-changed", load);
    window.addEventListener("jungle:workflow-changed", load);
    return () => {
      alive = false;
      window.removeEventListener("jungle:schedule-changed", load);
      window.removeEventListener("jungle:workflow-changed", load);
    };
  }, []);

  const recentDeliverables = deliverables.slice(0, 6);
  const firstName = (me?.display_name ?? "").split(/\s+/)[0] || me?.handle || "there";

  return (
    <ViewShell
      icon={<HomeIcon className="size-5" />}
      title="Home"
      sidebarOpen={sidebarOpen}
      onOpenDrawer={onOpenDrawer}
      onExpandSidebar={onExpandSidebar}
      testId="home-view"
    >
      <div className="mb-6">
        <h1 className="text-xl font-bold tracking-tight">
          {greeting()}, {firstName}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
          {working.length > 0 && (
            <>
              {" · "}
              {working.length} agent{working.length === 1 ? "" : "s"} working
            </>
          )}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_290px]">
        <div className="min-w-0 space-y-6">
          {/* Needs you: pending approvals + stalled workflow runs. */}
          <section data-testid="home-needs-you">
            <SectionLabel>
              Needs you{confirms.length + stalled.length > 0 ? ` · ${confirms.length + stalled.length}` : ""}
            </SectionLabel>
            {confirms.length + stalled.length === 0 ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                <Check className="size-4 text-primary" />
                Nothing waiting on you.
              </div>
            ) : (
              <div className="space-y-3">
                {stalled.map((wf) => (
                  <div
                    key={wf.id}
                    data-testid="stalled-run-card"
                    className="flex items-center gap-3 rounded-xl border border-amber-300/60 bg-amber-50/60 p-4 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/5"
                  >
                    <span className="text-lg leading-none">{wf.emoji ?? "⚠️"}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold">{wf.name} looks stalled</div>
                      <div className="text-xs text-muted-foreground">
                        The run went quiet mid-flight — nudge the team in its thread, or stop it.
                      </div>
                    </div>
                    <button
                      onClick={() => navigate(`/workflows/${wf.id}`)}
                      className="shrink-0 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
                    >
                      Open run
                    </button>
                  </div>
                ))}
                {confirms.map((c) => (
                  <ApprovalCard
                    key={c.confirmId}
                    c={c}
                    channel={byChannel.get(c.channelId)}
                    onDecide={onDecide}
                    onJumpToChannel={onJumpToChannel}
                  />
                ))}
              </div>
            )}
            {/* Threads left the sidebar nav — unread replies surface here instead. */}
            {totalThreadUnread > 0 && (
              <button
                data-testid="home-threads-row"
                onClick={onOpenThreads}
                className="mt-3 flex w-full items-center gap-2.5 rounded-xl border bg-card p-3 text-left text-sm shadow-sm transition-colors hover:border-primary/40"
              >
                <MessageSquare className="size-4 text-muted-foreground" />
                <span className="font-medium">
                  {totalThreadUnread} thread{totalThreadUnread === 1 ? "" : "s"} with new replies
                </span>
                <span className="ml-auto text-xs text-muted-foreground">View →</span>
              </button>
            )}
          </section>

          {/* While you were away: the recent deliverables feed. */}
          <section data-testid="home-recent">
            <SectionLabel>While you were away</SectionLabel>
            {recentDeliverables.length === 0 ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                <Package className="size-4" />
                When agents ship things — PRs, docs, issues — they land here.
              </div>
            ) : (
              <div className="space-y-2">
                {recentDeliverables.map((d) => (
                  <DeliverableRow key={d.id} d={d} onJumpToMessage={onJumpToMessage} />
                ))}
                {deliverables.length > recentDeliverables.length && (
                  <button
                    onClick={() => navigate("/deliverables")}
                    className="px-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                  >
                    See all deliverables →
                  </button>
                )}
              </div>
            )}
          </section>
        </div>

        <div className="space-y-6">
          {/* Live now: agents mid-turn. */}
          <section data-testid="home-live">
            <SectionLabel>Live now</SectionLabel>
            <div className="rounded-xl border bg-card p-3 shadow-sm">
              {working.length === 0 ? (
                <p className="p-1 text-sm text-muted-foreground">All quiet — no agents working.</p>
              ) : (
                <div className="space-y-1">
                  {working.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => onOpenAgentProfile(p.id)}
                      className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-accent"
                    >
                      <PersonAvatar name={p.display_name} handle={p.handle} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.display_name}</span>
                      <span className="flex items-center gap-1.5 text-xs text-primary">
                        <Radio className="size-3 animate-pulse" />
                        working
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Coming up: next scheduled fires (schedules + workflow triggers). */}
          <section data-testid="home-upcoming">
            <SectionLabel>Coming up</SectionLabel>
            <div className="rounded-xl border bg-card p-3 shadow-sm">
              {upcoming.length === 0 ? (
                <p className="p-1 text-sm text-muted-foreground">Nothing scheduled.</p>
              ) : (
                <div className="space-y-0.5">
                  {upcoming.map((u, i) => (
                    <button
                      key={i}
                      onClick={() => navigate(u.workflowId ? "/workflows" : "/scheduled")}
                      className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-accent"
                    >
                      <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">{u.label}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{fmtUpcoming(u.at)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </ViewShell>
  );
}
