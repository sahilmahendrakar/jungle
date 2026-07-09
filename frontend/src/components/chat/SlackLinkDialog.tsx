import { useEffect, useState } from "react";
import { Hash, Loader2, Search, Unlink } from "lucide-react";
import {
  getSlackStatus,
  listSlackChannels,
  linkChannelToSlack,
  unlinkChannelFromSlack,
  type SlackStatus,
  type SlackChannelInfo,
  type SlackChannelLink,
} from "../../api";
import { BrandGlyph } from "@/lib/connections";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Per-channel Slack mirroring: link this Jungle channel to a Slack channel (two-way mirror), or
// show/unlink the current binding. Workspace-level install lives in Settings; this only manages the
// per-channel link. Admin-only (the backend enforces it too). Reports changes up via onLinkChanged
// so the header updates immediately (the backend also broadcasts slack_link_changed).
export function SlackLinkDialog({
  open,
  onOpenChange,
  channelId,
  channelName,
  link,
  isAdmin,
  onLinkChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  channelId: string | null;
  channelName: string | undefined;
  link: SlackChannelLink | null;
  isAdmin: boolean;
  onLinkChanged: (link: SlackChannelLink | null) => void;
}) {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [channels, setChannels] = useState<SlackChannelInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const installed = status?.installed && status.status !== "revoked";

  // Load install status when opened.
  useEffect(() => {
    if (!open) return;
    setError("");
    getSlackStatus()
      .then(setStatus)
      .catch(() => setStatus({ installed: false }));
  }, [open]);

  // Load the Slack channel picker only when we're installed, unlinked, and an admin.
  useEffect(() => {
    if (!open || link || !installed || !isAdmin) return;
    setChannels(null);
    listSlackChannels()
      .then(setChannels)
      .catch((e) => setError(String(e.message ?? e)));
  }, [open, link, installed, isAdmin]);

  async function doLink(slackChannelId: string) {
    if (!channelId || busy) return;
    setBusy(true);
    setError("");
    try {
      const { link: created } = await linkChannelToSlack(channelId, slackChannelId);
      onLinkChanged(created);
      setQuery("");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function doUnlink() {
    if (!channelId || busy) return;
    setBusy(true);
    setError("");
    try {
      await unlinkChannelFromSlack(channelId);
      onLinkChanged(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = (channels ?? []).filter((c) => c.name.toLowerCase().includes(q));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <BrandGlyph brand="slack" className="size-4" />
            {channelName} · Slack mirroring
          </DialogTitle>
          <DialogDescription>
            Mirror this channel two-way with a Slack channel. Messages sync both directions, and you
            can @mention agents from Slack.
          </DialogDescription>
        </DialogHeader>

        {/* Not installed → send them to Settings. */}
        {status && !installed && (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            {status.installed
              ? "Your Slack connection needs to be reconnected. "
              : "Slack isn't connected for this workspace yet. "}
            {isAdmin ? "Connect it in Settings → Slack, then come back here." : "Ask a workspace admin to connect Slack in Settings."}
          </div>
        )}

        {/* Installed + already linked → show binding + unlink. */}
        {installed && link && (
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-xl border bg-card p-3">
              <BrandGlyph brand="slack" className="size-5" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">#{link.slackChannelName ?? link.slackChannelId}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {link.status === "error" ? (
                    <span className="text-destructive">Error: {link.lastError ?? "delivery failed"}</span>
                  ) : (
                    "Mirroring is active."
                  )}
                </div>
              </div>
              {isAdmin && (
                <Button variant="ghost" size="sm" onClick={() => void doUnlink()} disabled={busy} className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive">
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Unlink className="size-3.5" />}
                  Unlink
                </Button>
              )}
            </div>
            {!isAdmin && <p className="text-xs text-muted-foreground">Only a workspace admin can change this.</p>}
          </div>
        )}

        {/* Installed, unlinked, admin → channel picker. */}
        {installed && !link && isAdmin && (
          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search Slack channels…" className="pl-8" disabled={busy} />
            </div>
            <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border p-1">
              {channels === null ? (
                <div className="flex items-center justify-center py-6 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">No Slack channels match.</div>
              ) : (
                filtered.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => void doLink(c.id)}
                    disabled={busy}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                  >
                    <Hash className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{c.name}</span>
                    {c.isMember && <span className="ml-auto shrink-0 text-xs text-muted-foreground">joined</span>}
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {installed && !link && !isAdmin && (
          <p className="text-sm text-muted-foreground">Only a workspace admin can link this channel to Slack.</p>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
