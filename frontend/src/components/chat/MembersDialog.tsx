import { useState } from "react";
import { Bot, Hash, UserPlus, X } from "lucide-react";
import type { Participant } from "../../api";
import { PersonAvatar } from "./panels";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Channel members dialog: search-to-add people/agents + the current roster with per-row remove.
// Owns the transient add-query + busy UI state; the actual add/remove data ops (and any resulting
// channel-list/selection changes) are the parent's, passed as async handlers.
export function MembersDialog({
  open,
  onOpenChange,
  channelName,
  members,
  others,
  participantId,
  onAdd,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  channelName: string | undefined;
  members: Participant[];
  others: Participant[];
  participantId: string | null;
  onAdd: (handle: string) => Promise<void>;
  onRemove: (p: Participant) => Promise<void>;
}) {
  const [addQuery, setAddQuery] = useState("");
  const [memberBusy, setMemberBusy] = useState(false);

  async function add(handle: string) {
    if (memberBusy) return;
    setMemberBusy(true);
    try {
      await onAdd(handle);
      setAddQuery("");
    } finally {
      setMemberBusy(false);
    }
  }

  async function remove(p: Participant) {
    if (memberBusy) return;
    setMemberBusy(true);
    try {
      await onRemove(p);
    } finally {
      setMemberBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Hash className="size-4 text-muted-foreground" />
            {channelName} · members
          </DialogTitle>
          <DialogDescription>Add or remove who has access to this channel.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {/* Add people */}
          <div className="space-y-1.5">
            <div className="relative">
              <UserPlus className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                data-testid="member-add-input"
                value={addQuery}
                onChange={(e) => setAddQuery(e.target.value)}
                placeholder="Add people or agents by name…"
                className="pl-8"
                disabled={memberBusy}
              />
            </div>
            {addQuery.trim() && (
              <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border p-1">
                {(() => {
                  const q = addQuery.trim().toLowerCase();
                  const addable = others.filter(
                    (p) =>
                      !members.some((m) => m.id === p.id) &&
                      (p.display_name.toLowerCase().includes(q) || p.handle.toLowerCase().includes(q)),
                  );
                  if (!addable.length)
                    return <div className="px-2 py-2 text-sm text-muted-foreground">No matches.</div>;
                  return addable.map((p) => (
                    <button
                      key={p.id}
                      data-testid="member-add-option"
                      onClick={() => add(p.handle)}
                      disabled={memberBusy}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                    >
                      <PersonAvatar name={p.display_name} handle={p.handle} size="sm" />
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="truncate">{p.display_name}</span>
                        <span className="truncate text-muted-foreground">@{p.handle}</span>
                        {p.kind === "agent" && <Bot className="size-3.5 shrink-0 text-primary" />}
                      </span>
                    </button>
                  ));
                })()}
              </div>
            )}
          </div>

          {/* Current members */}
          <div className="max-h-72 space-y-0.5 overflow-y-auto">
            {members.map((p) => (
              <div
                key={p.id}
                data-testid="member-row"
                className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent"
              >
                <PersonAvatar name={p.display_name} handle={p.handle} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 truncate text-sm font-medium">
                    {p.display_name}
                    {p.kind === "agent" && <Bot className="size-3.5 shrink-0 text-primary" />}
                    {p.id === participantId && (
                      <span className="text-xs font-normal text-muted-foreground">(you)</span>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">@{p.handle}</div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid="member-remove"
                  onClick={() => remove(p)}
                  disabled={memberBusy}
                  title={p.id === participantId ? "Leave channel" : `Remove @${p.handle}`}
                  className="size-7 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
            {members.length === 0 && (
              <div className="px-2 py-3 text-sm text-muted-foreground">No members yet.</div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
