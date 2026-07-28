import { useEffect, useState } from "react";
import { Hash, Loader2, Search } from "lucide-react";
import { browseChannels, joinChannel, type BrowsableChannel } from "../../api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Browse-and-join dialog: every channel in the workspace has no public/private flag, so this
// lists every channel the current user hasn't joined yet and lets them self-serve join one — no
// invite required. Loads lazily on open (list can go stale between opens, e.g. someone else
// created a channel). On join, hands the new channel id back so the parent can reload + select it.
export function BrowseChannelsDialog({
  open,
  onOpenChange,
  onJoined,
  onNotice,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onJoined: (channelId: string) => void;
  onNotice: (msg: string) => void;
}) {
  const [channels, setChannels] = useState<BrowsableChannel[] | null>(null);
  const [query, setQuery] = useState("");
  const [joiningId, setJoiningId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setChannels(null);
    browseChannels()
      .then(setChannels)
      .catch((e) => onNotice(String((e as Error).message ?? e)));
  }, [open, onNotice]);

  async function join(c: BrowsableChannel) {
    if (joiningId) return;
    setJoiningId(c.id);
    try {
      await joinChannel(c.id);
      onOpenChange(false);
      onJoined(c.id);
    } catch (e) {
      onNotice(String((e as Error).message ?? e));
    } finally {
      setJoiningId(null);
    }
  }

  const q = query.trim().toLowerCase();
  const filtered = (channels ?? []).filter((c) => c.name.toLowerCase().includes(q));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Browse channels</DialogTitle>
          <DialogDescription>
            Every channel is open — join any of these to start seeing its messages.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              data-testid="browse-channels-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search channels…"
              className="pl-8"
            />
          </div>
          <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border p-1">
            {channels === null ? (
              <div className="flex items-center justify-center py-6 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">
                {channels.length === 0 ? "You're already in every channel." : "No channels match."}
              </div>
            ) : (
              filtered.map((c) => (
                <div
                  key={c.id}
                  data-testid="browse-channel-row"
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent"
                >
                  <Hash className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{c.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {c.member_count} member{c.member_count === 1 ? "" : "s"}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="join-channel-button"
                    onClick={() => join(c)}
                    disabled={joiningId === c.id}
                  >
                    {joiningId === c.id ? <Loader2 className="size-3.5 animate-spin" /> : "Join"}
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
