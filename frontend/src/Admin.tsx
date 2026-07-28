import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Loader2, ShieldCheck } from "lucide-react";
import {
  adminAccounts,
  adminActivity,
  adminAgents,
  adminOverview,
  type AdminAccount,
  type AdminActivityItem,
  type AdminAgentUsage,
  type AdminOverview,
  type AdminWindow,
} from "./api";
import { fmtRelative, fmtTokens } from "./lib/chat";
import { ViewShell } from "./components/chat/ViewShell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The operator view: platform-wide usage and spend, rolled up by account. Reachable from
// Settings only for accounts the backend flags as operators (me.isAdmin); every fetch here is
// re-gated server-side, so a user who guesses the URL gets an error card, not data.
//
// Dollars are the Agent SDK's own per-turn estimates (result.modelUsage[].costUSD) summed up —
// accurate for Anthropic models, high for models routed to another provider (GLM/kimi via z.ai),
// which is called out in the UI rather than silently corrected.

const WINDOWS: { id: AdminWindow; label: string }[] = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];

const WINDOW_LABEL: Record<AdminWindow, string> = {
  "24h": "in the last 24 hours",
  "7d": "in the last 7 days",
  "30d": "in the last 30 days",
  all: "all time",
};

function usd(n: number): string {
  if (n >= 10_000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n === 0) return "$0";
  return `$${n.toFixed(3)}`;
}

function count(n: number): string {
  return n.toLocaleString();
}

// --- figures ------------------------------------------------------------------------------

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold leading-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

// Daily spend, one column per UTC day. A single series, so no legend — the heading names it;
// only the peak day is direct-labelled and the rest live in the hover tooltip.
function SpendChart({
  points,
  granularity,
}: {
  points: { date: string; costUsd: number; turns: number; tokens: number }[];
  granularity: "hour" | "day";
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...points.map((p) => p.costUsd), 0);
  const peak = points.findIndex((p) => p.costUsd === max);
  if (!points.length || max <= 0) {
    return (
      <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        No spend recorded in this window.
      </p>
    );
  }
  // Buckets are UTC; labels render in UTC too, so a bar always means the range the server summed.
  const day = (d: string) => {
    const t = new Date(granularity === "hour" ? d : `${d}T00:00:00Z`);
    return granularity === "hour"
      ? t.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", timeZone: "UTC" }) + " UTC"
      : t.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
  };
  const active = hover != null ? points[hover] : null;
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">Spend per {granularity}</h3>
        <span className="text-xs tabular-nums text-muted-foreground">peak {usd(max)}</span>
      </div>
      <div className="relative mt-4">
        {/* Tooltip: pinned above the plot so it never covers the column being read. */}
        <div className="h-8">
          {active && (
            <div className="inline-flex items-center gap-2 rounded-lg border bg-popover px-2.5 py-1 text-xs shadow-sm">
              <span className="size-2 rounded-[2px] bg-primary" />
              <span className="font-medium">{day(active.date)}</span>
              <span className="tabular-nums">{usd(active.costUsd)}</span>
              <span className="text-muted-foreground tabular-nums">
                {active.turns} {active.turns === 1 ? "turn" : "turns"} · {fmtTokens(active.tokens)} tok
              </span>
            </div>
          )}
        </div>
        <div className="flex h-32 items-end gap-[2px] border-b">
          {points.map((p, i) => (
            <button
              type="button"
              key={p.date}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              onFocus={() => setHover(i)}
              onBlur={() => setHover((h) => (h === i ? null : h))}
              aria-label={`${day(p.date)}: ${usd(p.costUsd)}, ${p.turns} turns`}
              className="group relative flex h-full max-w-6 flex-1 items-end justify-center"
            >
              <span
                className={cn(
                  "w-full rounded-t-[4px] bg-primary transition-opacity",
                  hover != null && hover !== i && "opacity-40",
                )}
                style={{ height: `${Math.max((p.costUsd / max) * 100, p.costUsd > 0 ? 2 : 0)}%` }}
              />
              {i === peak && (
                <span className="pointer-events-none absolute -top-4 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground">
                  {usd(max)}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
        <span>{day(points[0].date)}</span>
        <span>{day(points[points.length - 1].date)}</span>
      </div>
    </div>
  );
}

// --- account rows -------------------------------------------------------------------------

function AgentRows({ agents }: { agents: AdminAgentUsage[] }) {
  if (!agents.length) {
    return <div className="px-4 py-3 text-xs text-muted-foreground">No agents.</div>;
  }
  return (
    <table className="w-full text-xs">
      <thead className="text-muted-foreground">
        <tr className="border-b">
          <th className="px-4 py-1.5 text-left font-medium">Agent</th>
          <th className="py-1.5 text-left font-medium">Workspace</th>
          <th className="py-1.5 text-left font-medium">Model</th>
          <th className="py-1.5 text-right font-medium">Turns</th>
          <th className="py-1.5 text-right font-medium">Tokens</th>
          <th className="py-1.5 text-right font-medium">Spend</th>
          <th className="px-4 py-1.5 text-right font-medium">Last turn</th>
        </tr>
      </thead>
      <tbody>
        {agents.map((a) => (
          <tr key={a.agentId ?? a.handle} className="border-b last:border-0">
            <td className="max-w-[14rem] truncate px-4 py-1.5">
              @{a.handle}
              {a.deleted && <span className="ml-1.5 text-muted-foreground">(deleted)</span>}
            </td>
            <td className="max-w-[10rem] truncate py-1.5 text-muted-foreground">{a.workspaceName ?? "—"}</td>
            <td className="max-w-[10rem] truncate py-1.5 text-muted-foreground">{a.model ?? "default"}</td>
            <td className="py-1.5 text-right tabular-nums">{count(a.turns)}</td>
            <td className="py-1.5 text-right tabular-nums">{fmtTokens(a.tokens.total)}</td>
            <td className="py-1.5 text-right tabular-nums">{usd(a.costUsd)}</td>
            <td className="px-4 py-1.5 text-right tabular-nums text-muted-foreground">
              {fmtRelative(a.lastActiveAt)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AccountRow({ account, window: w }: { account: AdminAccount; window: AdminWindow }) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AdminAgentUsage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Agents load on first expand (and again when the window changes under an open row).
  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    adminAgents(w, account.key)
      .then((a) => live && setAgents(a))
      .catch((e) => live && setError(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, [open, w, account.key]);

  const name = account.name ?? account.email ?? "Unknown account";
  return (
    <div className="border-b last:border-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid={`admin-account-${account.key}`}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/50"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-[2]">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {account.email ?? "no email"}
            {account.workspaces.length > 0 && ` · ${account.workspaces.map((x) => x.name).join(", ")}`}
          </span>
        </span>
        <span className="w-16 shrink-0 text-right text-xs tabular-nums">
          {count(account.activeAgents)}
          <span className="text-muted-foreground">/{count(account.agents)}</span>
        </span>
        <span className="w-14 shrink-0 text-right text-xs tabular-nums">{count(account.turns)}</span>
        <span className="w-16 shrink-0 text-right text-xs tabular-nums">{fmtTokens(account.tokens.total)}</span>
        <span className="w-16 shrink-0 text-right text-sm font-medium tabular-nums">{usd(account.costUsd)}</span>
        <span className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
          {fmtRelative(account.lastActiveAt)}
        </span>
      </button>
      {open && (
        <div className="bg-muted/30">
          {error ? (
            <div className="px-4 py-3 text-xs text-destructive">{error}</div>
          ) : agents ? (
            <AgentRows agents={agents} />
          ) : (
            <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading agents…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- page ---------------------------------------------------------------------------------

export function Admin({
  sidebarOpen,
  onOpenDrawer,
  onExpandSidebar,
}: {
  sidebarOpen: boolean;
  onOpenDrawer: () => void;
  onExpandSidebar: () => void;
}) {
  const [w, setW] = useState<AdminWindow>("7d");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [activity, setActivity] = useState<AdminActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    Promise.all([adminOverview(w), adminAccounts(w), adminActivity(w, 40)])
      .then(([o, a, act]) => {
        if (!live) return;
        setOverview(o);
        setAccounts(a);
        setActivity(act);
      })
      .catch((e) => live && setError(String((e as Error).message)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [w]);

  const t = overview?.totals;
  // Share-of-spend bars in the model split are magnitude against the top model, not a category
  // scale — one hue, no legend.
  const topModelCost = useMemo(
    () => Math.max(...(overview?.models ?? []).map((m) => m.costUsd), 0),
    [overview],
  );

  return (
    <ViewShell
      testId="admin-view"
      icon={<ShieldCheck className="size-4" />}
      title="Admin"
      wide
      sidebarOpen={sidebarOpen}
      onOpenDrawer={onOpenDrawer}
      onExpandSidebar={onExpandSidebar}
      actions={
        <div className="flex items-center gap-1">
          {loading && <Loader2 className="mr-1 size-3.5 animate-spin text-muted-foreground" />}
          {WINDOWS.map((opt) => (
            <Button
              key={opt.id}
              size="sm"
              variant={w === opt.id ? "secondary" : "ghost"}
              data-testid={`admin-window-${opt.id}`}
              onClick={() => setW(opt.id)}
              className="h-7 px-2 text-xs"
            >
              {opt.label}
            </Button>
          ))}
        </div>
      }
    >
      {error && (
        <p className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* Hero: the number this page exists for. */}
      <section className="rounded-xl border bg-card px-5 py-4">
        <div className="text-xs text-muted-foreground">Spend {WINDOW_LABEL[w]}</div>
        <div className="mt-1 text-5xl font-semibold leading-none">{t ? usd(t.costUsd) : "—"}</div>
        <p className="mt-2 text-xs text-muted-foreground">
          The Agent SDK's own per-turn estimate. Models routed to another provider (GLM, kimi via
          z.ai) are priced at Anthropic rates here, so their share reads high.
        </p>
      </section>

      <section className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Users" value={t ? count(t.users) : "—"} hint={t ? `${count(t.workspaces)} workspaces` : undefined} />
        <StatTile
          label="Agents"
          value={t ? count(t.agents) : "—"}
          hint={t ? `${count(t.activeAgents)} ran a turn` : undefined}
        />
        <StatTile label="Turns" value={t ? count(t.turns) : "—"} hint={WINDOW_LABEL[w]} />
        <StatTile label="Tokens" value={t ? fmtTokens(t.tokens.total) : "—"} hint={t ? `${fmtTokens(t.tokens.cacheRead)} cache reads` : undefined} />
        <StatTile label="Output tokens" value={t ? fmtTokens(t.tokens.output) : "—"} hint={t ? `${fmtTokens(t.tokens.input)} input` : undefined} />
        <StatTile label="Messages" value={t ? count(t.messages) : "—"} hint={WINDOW_LABEL[w]} />
      </section>

      <section className="mt-6">
        <SpendChart points={overview?.daily ?? []} granularity={overview?.granularity ?? "day"} />
      </section>

      {/* Spend by model */}
      {!!overview?.models.length && (
        <section className="mt-6 rounded-xl border bg-card p-4">
          <h3 className="text-sm font-medium">Spend by model</h3>
          <div className="mt-3 space-y-2">
            {overview.models.map((m) => (
              <div key={m.model} className="flex items-center gap-3">
                <span className="w-40 shrink-0 truncate text-xs">{m.model}</span>
                <span className="h-2 min-w-[2px] flex-1 rounded-[2px] bg-muted">
                  <span
                    className="block h-2 rounded-[2px] bg-primary"
                    style={{ width: `${topModelCost > 0 ? Math.max((m.costUsd / topModelCost) * 100, 1) : 0}%` }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {count(m.turns)} {m.turns === 1 ? "turn" : "turns"}
                </span>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums">{usd(m.costUsd)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Accounts */}
      <section className="mt-6">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Accounts</h2>
          <span className="text-xs text-muted-foreground">Expand a row for its agents</span>
        </div>
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center gap-3 border-b bg-muted/40 px-4 py-1.5 text-[11px] text-muted-foreground">
            <span className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-[2]">Account</span>
            <span className="w-16 shrink-0 text-right">Agents</span>
            <span className="w-14 shrink-0 text-right">Turns</span>
            <span className="w-16 shrink-0 text-right">Tokens</span>
            <span className="w-16 shrink-0 text-right">Spend</span>
            <span className="hidden w-20 shrink-0 text-right sm:block">Last turn</span>
          </div>
          {accounts.map((a) => (
            <AccountRow key={a.key} account={a} window={w} />
          ))}
          {!accounts.length && !loading && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">No accounts yet.</div>
          )}
        </div>
      </section>

      {/* Recent turns */}
      <section className="mt-6">
        <h2 className="mb-2 text-sm font-medium">Recent activity</h2>
        <div className="overflow-hidden rounded-xl border bg-card">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-[11px] text-muted-foreground">
              <tr>
                <th className="px-4 py-1.5 text-left font-medium">When</th>
                <th className="py-1.5 text-left font-medium">Agent</th>
                <th className="py-1.5 text-left font-medium">Account</th>
                <th className="py-1.5 text-left font-medium">Model</th>
                <th className="py-1.5 text-right font-medium">Tokens</th>
                <th className="px-4 py-1.5 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {activity.map((item, i) => (
                <tr key={`${item.turnId ?? item.at}-${item.model}-${i}`} className="border-t">
                  <td className="whitespace-nowrap px-4 py-1.5 tabular-nums text-muted-foreground">
                    {fmtRelative(item.at)}
                  </td>
                  <td className="max-w-[12rem] truncate py-1.5">
                    @{item.agentHandle}
                    {!item.ok && <span className="ml-1.5 text-destructive">failed</span>}
                  </td>
                  <td className="max-w-[14rem] truncate py-1.5 text-muted-foreground">
                    {item.ownerEmail ?? "—"}
                  </td>
                  <td className="max-w-[10rem] truncate py-1.5 text-muted-foreground">{item.model}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtTokens(item.tokens)}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums">{usd(item.costUsd)}</td>
                </tr>
              ))}
              {!activity.length && !loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No turns in this window.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </ViewShell>
  );
}
