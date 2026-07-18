import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, MessageSquare, X, Zap } from "lucide-react";
import type { Participant, Workflow, WorkflowRole, WorkflowTrigger } from "../../api";
import { getIntegrationType, INTEGRATION_TYPES } from "@jungle/shared";
import type { ConnectionsApi } from "../../lib/connections";
import { PersonAvatar } from "../chat/panels";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// The workflow canvas: trigger → the team, staged left-to-right → you. ONE component, two
// modes — the builder renders it editable (click a node to open its real profile panel, ✕ to
// remove, inline role title), the detail page renders it live (working pulses ride participant
// status). Stages/edge labels are presentation hints on the roster (see shared/src/workflows.ts);
// the layout is fully computed (no DOM measuring, no drag): fixed node sizes, columns centered
// vertically, bezier connectors between adjacent columns.

// ---- trigger copy (shared by the canvas node and the detail header sentence) ----

const HOUR_LABEL = (h: number) =>
  h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;

// Parse the friendly cron shape ("M H * * D") the trigger editor writes; null for exotic crons.
function parseSimpleCron(cron: string): { hour: number; days: string } | null {
  const p = cron.split(" ");
  if (p.length !== 5 || p[2] !== "*" || p[3] !== "*" || !/^\d+$/.test(p[1])) return null;
  return { hour: Number(p[1]), days: p[4] };
}

export function triggerSummary(t: WorkflowTrigger): { title: string; sub: string } {
  if (t.type === "schedule") {
    const s = parseSimpleCron(t.cron);
    if (s) {
      const days = s.days === "1-5" ? "Weekdays" : s.days === "*" ? "Every day" : "On a schedule";
      return { title: days, sub: HOUR_LABEL(s.hour) };
    }
    return { title: "On a schedule", sub: t.cron };
  }
  if (t.type === "channel_message") return { title: "On a message", sub: "@mention the first agent" };
  return { title: "Manual", sub: "the Run now button" };
}

// One plain-English line for headers: "Every weekday at 8:00 AM (PT) · lives in #support-triage".
export function triggerSentence(w: Workflow): string {
  const t = w.trigger;
  let s: string;
  if (t.type === "schedule") {
    const c = parseSimpleCron(t.cron);
    const tz = t.timezone.split("/").pop()?.replace(/_/g, " ") ?? t.timezone;
    s = c
      ? `${c.days === "1-5" ? "Every weekday" : c.days === "*" ? "Every day" : "On a schedule"} at ${HOUR_LABEL(c.hour)} (${tz})`
      : `On a schedule (${t.cron})`;
  } else if (t.type === "channel_message") {
    s = "Starts from a message";
  } else {
    s = "Runs when you press Run now";
  }
  return w.home_channel_name ? `${s} · lives in #${w.home_channel_name}` : s;
}

// ---- integration status helpers ----

// Integration keys used across the roster, in first-appearance order.
export function rosterIntegrationKeys(roster: WorkflowRole[]): string[] {
  const out: string[] = [];
  for (const r of roster) for (const k of r.integrations) if (!out.includes(k)) out.push(k);
  return out;
}

// Integration keys whose underlying per-user connection is linked (github/google/mcp OAuth).
export function connectedIntegrationKeys(connections: ConnectionsApi["connections"]): Set<string> {
  const linked = new Set(connections.filter((c) => c.connected).map((c) => c.key));
  const out = new Set<string>();
  for (const t of INTEGRATION_TYPES) if (linked.has(t.connectionKey)) out.add(t.key);
  return out;
}

function IntegrationChip({
  intKey,
  connected,
  onOpenConnections,
}: {
  intKey: string;
  connected: boolean;
  onOpenConnections?: () => void;
}) {
  const name = getIntegrationType(intKey)?.name ?? intKey;
  return (
    <span
      role={onOpenConnections ? "button" : undefined}
      onClick={
        onOpenConnections
          ? (e) => {
              // The chip sits inside the agent card (whose own click opens the profile) — the
              // chip's target wins: integrations lead to the user's connections settings.
              e.stopPropagation();
              onOpenConnections();
            }
          : undefined
      }
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
        onOpenConnections && "cursor-pointer hover:border-primary/50",
        connected
          ? "border-border text-muted-foreground"
          : "border-amber-400/60 bg-amber-50/60 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400",
      )}
      title={connected ? `${name} connected — manage in Settings` : `${name} needs connecting — open your connections settings`}
    >
      <span className={cn("size-1.5 rounded-full", connected ? "bg-emerald-500" : "bg-amber-500")} />
      {name}
    </span>
  );
}

// ---- layout ----

const AGENT_W = 172;
const SIDE_W = 124; // trigger + you nodes
const BASE_H = 58;
const CHIPS_H = 26; // extra height when a node has an integration chip row
const COL_GAP = 56; // room for the connector + its label
const ROW_GAP = 18;
const PAD = 8;

interface Node {
  key: string;
  kind: "trigger" | "agent" | "user";
  col: number;
  row: number;
  w: number;
  h: number;
  title: string;
  sub: string;
  rosterIndex?: number;
  role?: WorkflowRole;
  agent?: Participant;
  chips?: string[]; // integration keys
}

function buildNodes(w: Workflow, byId: Map<string, Participant>): { nodes: Node[]; colCount: number; label: Map<number, string> } {
  const nodes: Node[] = [];
  const trig = triggerSummary(w.trigger);
  nodes.push({ key: "trigger", kind: "trigger", col: 0, row: 0, w: SIDE_W, h: BASE_H, title: trig.title, sub: trig.sub });

  // Fold roster indexes into stages: an unset stage means "one after the previous role", so
  // plain rosters render as a chain and template fan-outs stack.
  let prev = 0;
  const stageOf = w.roster.map((r) => {
    const v = r.stage && r.stage > 0 ? r.stage : prev + 1;
    prev = Math.max(prev, v);
    return v;
  });
  const stageVals = [...new Set(stageOf)].sort((a, b) => a - b);
  const label = new Map<number, string>(); // canvas column -> caption on the connectors into it
  stageVals.forEach((v, s) => {
    const idxs = stageOf.map((sv, i) => (sv === v ? i : -1)).filter((i) => i >= 0);
    const el = w.roster[idxs[0]]?.edge_label;
    if (el) label.set(s + 1, el);
    idxs.forEach((rosterIndex, row) => {
      const role = w.roster[rosterIndex];
      const agent = role.participant_id ? byId.get(role.participant_id) : undefined;
      const chips = role.integrations;
      nodes.push({
        key: role.participant_id ?? `seat-${rosterIndex}`,
        kind: "agent",
        col: s + 1,
        row,
        w: AGENT_W,
        h: BASE_H + (chips.length > 0 ? CHIPS_H : 0),
        title: agent?.display_name ?? role.name ?? `@${role.handle_seed}`,
        sub: role.role,
        rosterIndex,
        role,
        agent,
        chips,
      });
    });
  });

  const youCol = stageVals.length + 1;
  nodes.push({ key: "you", kind: "user", col: youCol, row: 0, w: SIDE_W, h: BASE_H, title: "You", sub: "get the report" });
  return { nodes, colCount: youCol + 1, label };
}

// ---- the canvas ----

export function WorkflowCanvas({
  w,
  participants,
  connectedKeys,
  selectedId,
  onSelectAgent,
  onOpenConnections,
  edit,
}: {
  w: Workflow;
  participants: Participant[];
  connectedKeys: Set<string>;
  selectedId?: string | null;
  onSelectAgent?: (participantId: string) => void;
  onOpenConnections?: () => void;
  edit?: {
    onRemoveAgent: (participantId: string) => void;
    onRoleTitle: (rosterIndex: number, title: string) => void;
  };
}) {
  const byId = useMemo(() => new Map(participants.map((p) => [p.id, p])), [participants]);
  const { nodes, colCount, label } = useMemo(() => buildNodes(w, byId), [w, byId]);

  // Fit-to-width: the whole flow should be visible at once, so when the computed layout is
  // wider than the card we scale it down (to a floor — below that it scrolls instead).
  const MIN_SCALE = 0.6;
  const outerRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const measure = () => setAvail(el.clientWidth - 34); // minus the card's p-4 + border
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Column geometry: x from per-column widths; y centers each column's stack in the canvas.
  const colW: number[] = [];
  const colH: number[] = [];
  for (const n of nodes) {
    colW[n.col] = Math.max(colW[n.col] ?? 0, n.w);
    colH[n.col] = (colH[n.col] ?? 0) + n.h + (n.row > 0 ? ROW_GAP : 0);
  }
  const colX: number[] = [];
  let x = PAD;
  for (let c = 0; c < colCount; c++) {
    colX[c] = x;
    x += (colW[c] ?? SIDE_W) + COL_GAP;
  }
  const height = Math.max(...colH) + PAD * 2;
  const width = x - COL_GAP + PAD;

  const pos = new Map<string, { x: number; y: number }>();
  const rowY: number[] = [];
  for (const n of nodes) {
    const y = n.row === 0 ? (height - colH[n.col]) / 2 : rowY[n.col];
    rowY[n.col] = y + n.h + ROW_GAP;
    pos.set(n.key, { x: colX[n.col] + ((colW[n.col] ?? n.w) - n.w) / 2, y });
  }

  // Connectors: every node in column c → every node in column c+1 (the roster is a relay with
  // fan-out at stacked columns — matches how the playbook reads).
  const edges: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let c = 0; c < colCount - 1; c++) {
    for (const f of nodes.filter((n) => n.col === c)) {
      for (const t of nodes.filter((n) => n.col === c + 1)) {
        const fp = pos.get(f.key)!;
        const tp = pos.get(t.key)!;
        edges.push({ x1: fp.x + f.w, y1: fp.y + f.h / 2, x2: tp.x, y2: tp.y + t.h / 2 });
      }
    }
  }

  const scale = avail ? Math.max(MIN_SCALE, Math.min(1, avail / width)) : 1;

  return (
    <div ref={outerRef} className="overflow-x-auto rounded-xl border bg-card p-4 shadow-sm" data-testid="workflow-canvas">
      <div className="mx-auto" style={{ width: width * scale, height: height * scale }}>
        <div className="relative" style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        <svg className="pointer-events-none absolute inset-0" width={width} height={height}>
          {edges.map((e, i) => (
            <path
              key={i}
              d={`M ${e.x1} ${e.y1} C ${e.x1 + COL_GAP / 2} ${e.y1}, ${e.x2 - COL_GAP / 2} ${e.y2}, ${e.x2} ${e.y2}`}
              fill="none"
              className="stroke-primary/40"
              strokeWidth="1.5"
              strokeDasharray="5 4"
            />
          ))}
          {[...label.entries()].map(([col, text]) => (
            <text
              key={col}
              x={colX[col] - COL_GAP / 2}
              y={height / 2 - 8}
              textAnchor="middle"
              className="fill-muted-foreground stroke-card text-[10px] font-medium"
              strokeWidth={5}
              style={{ paintOrder: "stroke" }}
            >
              {text}
            </text>
          ))}
        </svg>

        {nodes.map((n) => {
          const p = pos.get(n.key)!;
          const working = n.agent?.status === "working";
          const clickable = n.kind === "agent" && !!n.role?.participant_id && !!onSelectAgent;
          const selected = n.kind === "agent" && !!selectedId && n.role?.participant_id === selectedId;
          const card = (
            <div
              key={n.key}
              data-testid={n.kind === "agent" ? "canvas-agent" : `canvas-${n.kind}`}
              onClick={() => clickable && onSelectAgent!(n.role!.participant_id!)}
              className={cn(
                "group absolute flex flex-col justify-center rounded-xl border bg-background p-2.5 shadow-sm",
                n.kind === "trigger" && "border-dashed border-primary/50 bg-accent",
                clickable && "cursor-pointer transition-colors hover:border-primary/50",
                selected && "border-primary ring-2 ring-primary/20",
                working && !selected && "border-primary ring-2 ring-primary/15",
              )}
              style={{ left: p.x, top: p.y, width: n.w, height: n.h }}
            >
              <div className="flex items-center gap-2">
                {n.kind === "trigger" ? (
                  w.trigger.type === "channel_message" ? (
                    <MessageSquare className="size-4 shrink-0 text-accent-foreground/70" />
                  ) : w.trigger.type === "manual" ? (
                    <Zap className="size-4 shrink-0 text-accent-foreground/70" />
                  ) : (
                    <CalendarClock className="size-4 shrink-0 text-accent-foreground/70" />
                  )
                ) : (
                  <PersonAvatar name={n.title} handle={n.kind === "user" ? "you" : (n.agent?.handle ?? n.role?.handle_seed ?? n.title)} size="sm" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-semibold">{n.title}</span>
                    {working && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />}
                  </div>
                  {edit && n.kind === "agent" && n.rosterIndex !== undefined ? (
                    <input
                      data-testid="seat-role"
                      defaultValue={n.sub}
                      placeholder="role"
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== n.sub) edit.onRoleTitle(n.rosterIndex!, v);
                      }}
                      className="w-full truncate border-0 bg-transparent p-0 text-[10px] text-muted-foreground outline-none placeholder:text-muted-foreground/50"
                    />
                  ) : (
                    <div className="truncate text-[10px] text-muted-foreground">{n.sub}</div>
                  )}
                </div>
              </div>
              {n.chips && n.chips.length > 0 && (
                <div className="mt-1.5 flex gap-1 overflow-hidden">
                  {n.chips.map((k) => (
                    <IntegrationChip key={k} intKey={k} connected={connectedKeys.has(k)} onOpenConnections={onOpenConnections} />
                  ))}
                </div>
              )}
              {edit && n.kind === "agent" && n.role?.participant_id && w.roster.length > 1 && (
                <button
                  data-testid="remove-agent"
                  onClick={(e) => {
                    e.stopPropagation();
                    edit.onRemoveAgent(n.role!.participant_id!);
                  }}
                  className="absolute -right-1.5 -top-1.5 hidden size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-destructive group-hover:flex"
                  title="Remove from workflow"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          );
          // Duties on hover — the fast way to see what each teammate does without opening it.
          if (n.kind !== "agent") return card;
          return (
            <Tooltip key={n.key}>
              <TooltipTrigger asChild>{card}</TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                <p className="font-medium">{n.title}</p>
                <p className="mt-1 text-xs opacity-80">
                  {n.role?.duties || "No instructions yet — click to add them."}
                </p>
                {clickable && <p className="mt-1 text-[10px] opacity-60">Click to edit instructions & connections</p>}
              </TooltipContent>
            </Tooltip>
          );
        })}
        </div>
      </div>
    </div>
  );
}

// A compact "are the tools hooked up" panel: every integration the roster uses, with its
// connection status. Clicking any row opens the user's connections settings — that's where
// account links live, so it's the shortest path to fixing (or checking) a connection.
export function ConnectionsPanel({
  w,
  connectedKeys,
  onOpenConnections,
}: {
  w: Workflow;
  connectedKeys: Set<string>;
  onOpenConnections?: () => void;
}) {
  const keys = rosterIntegrationKeys(w.roster);
  if (keys.length === 0) {
    return <p className="px-1 text-xs text-muted-foreground">This team doesn't use any integrations.</p>;
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm" data-testid="workflow-connections">
      {keys.map((k, i) => {
        const ok = connectedKeys.has(k);
        const clickable = !!onOpenConnections;
        return (
          <div
            key={k}
            role={clickable ? "button" : undefined}
            onClick={() => clickable && onOpenConnections()}
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-sm",
              i > 0 && "border-t",
              clickable && "cursor-pointer hover:bg-accent/50",
            )}
          >
            <span className={cn("size-2 rounded-full", ok ? "bg-emerald-500" : "bg-amber-500")} />
            <span className="min-w-0 flex-1 truncate">{getIntegrationType(k)?.name ?? k}</span>
            <span className={cn("text-xs", ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>
              {ok ? "Connected" : "Not connected"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
