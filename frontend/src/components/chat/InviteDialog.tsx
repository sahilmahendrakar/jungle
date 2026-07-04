import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Link2, Loader2, Trash2 } from "lucide-react";
import { createInvite, listInvites, revokeInvite, type Invite } from "../../api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

function inviteUrl(token: string): string {
  return `${location.origin}/join/${token}`;
}

// Admin dialog to create + manage shareable invite links for the active workspace. Anyone who
// opens a link and signs in with Google can join.
export function InviteDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: string;
}) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    listInvites(workspaceId)
      .then(setInvites)
      .catch((e) => setError(String((e as Error).message ?? e)))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  useEffect(() => {
    if (open) {
      setError("");
      reload();
    }
  }, [open, reload]);

  async function create() {
    setError("");
    setBusy(true);
    try {
      const inv = await createInvite(workspaceId);
      setInvites((prev) => [inv, ...prev]);
      await copy(inv.token);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(inviteUrl(token));
      setCopied(token);
      setTimeout(() => setCopied((c) => (c === token ? null : c)), 1500);
    } catch {
      /* clipboard blocked — the link is still visible to select manually */
    }
  }

  async function revoke(token: string) {
    setInvites((prev) => prev.filter((i) => i.token !== token));
    try {
      await revokeInvite(token);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      reload();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite people</DialogTitle>
          <DialogDescription>
            Share a link — anyone who opens it and signs in joins this workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          <Button onClick={create} disabled={busy} className="w-full gap-2">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
            Create invite link
          </Button>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {loading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : invites.length === 0 ? (
            <p className="py-3 text-center text-sm text-muted-foreground">No active invite links.</p>
          ) : (
            <div className="max-h-60 space-y-1.5 overflow-y-auto">
              {invites.map((inv) => (
                <div
                  key={inv.token}
                  className="flex items-start gap-2 rounded-lg border px-2.5 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1 break-all font-mono text-xs text-muted-foreground">
                    {inviteUrl(inv.token)}
                  </span>
                  <button
                    onClick={() => copy(inv.token)}
                    title="Copy link"
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {copied === inv.token ? (
                      <Check className="size-4 text-emerald-500" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </button>
                  <button
                    onClick={() => revoke(inv.token)}
                    title="Revoke link"
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
