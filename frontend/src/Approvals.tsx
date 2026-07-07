import { Check, Hash, ShieldCheck, ShieldQuestion, X } from "lucide-react";
import type { Channel } from "./api";
import { fmtRelative, type ToolConfirm } from "./lib/chat";
import { ViewShell } from "./components/chat/ViewShell";
import { Button } from "@/components/ui/button";

// The approvals inbox: every tool confirmation waiting on YOU, across all conversations. An
// always_ask agent blocks mid-turn until someone decides — this view (plus the sidebar badge and
// desktop ping) makes sure a request never stalls invisibly in a channel you don't have open.

function pretty(input: unknown): string {
  try {
    return typeof input === "string" ? input : JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function ApprovalCard({
  c,
  channel,
  onDecide,
  onJumpToChannel,
}: {
  c: ToolConfirm;
  channel: Channel | undefined;
  onDecide: (c: ToolConfirm, d: "allow" | "deny") => void;
  onJumpToChannel: (channelId: string) => void;
}) {
  const summary = pretty(c.input);
  const where = channel ? (channel.kind === "dm" ? `@${channel.dm_with}` : `#${channel.name}`) : null;
  return (
    <div
      data-testid="approval-card"
      className="rounded-xl border border-amber-300/60 bg-amber-50/60 p-4 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/5"
    >
      <div className="flex items-start gap-3">
        <ShieldQuestion className="mt-0.5 size-5 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <div className="text-sm">
            <span className="font-semibold">{c.agentName}</span> wants to run{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{c.tool}</code>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            {where && (
              <button
                onClick={() => onJumpToChannel(c.channelId)}
                className="inline-flex items-center gap-0.5 rounded hover:text-foreground hover:underline"
              >
                <Hash className="size-3" />
                {where.replace(/^[#@]/, "")}
              </button>
            )}
            {c.createdAt && <span>· {fmtRelative(c.createdAt)}</span>}
          </div>
          {summary && summary !== "{}" && (
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg border bg-background/70 p-2 text-[11px] leading-relaxed">
              {summary}
            </pre>
          )}
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              data-testid="approval-allow"
              onClick={() => onDecide(c, "allow")}
              className="h-8"
            >
              <Check className="size-4" /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="approval-deny"
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

export function Approvals({
  confirms,
  channels,
  sidebarOpen,
  onOpenDrawer,
  onExpandSidebar,
  onDecide,
  onJumpToChannel,
}: {
  confirms: ToolConfirm[];
  channels: Channel[];
  sidebarOpen: boolean;
  onOpenDrawer: () => void;
  onExpandSidebar: () => void;
  onDecide: (c: ToolConfirm, d: "allow" | "deny") => void;
  onJumpToChannel: (channelId: string) => void;
}) {
  const byChannel = new Map(channels.map((c) => [c.id, c]));
  return (
    <ViewShell
      icon={<ShieldQuestion className="size-5" />}
      title="Approvals"
      sidebarOpen={sidebarOpen}
      onOpenDrawer={onOpenDrawer}
      onExpandSidebar={onExpandSidebar}
      testId="approvals-view"
    >
      {confirms.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <ShieldCheck className="mx-auto size-8 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium">Nothing waiting on you</p>
          <p className="mt-1 text-sm text-muted-foreground">
            When an agent needs your sign-off on a sensitive action, it shows up here — and your
            work never stalls silently.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
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
    </ViewShell>
  );
}
