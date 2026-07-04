import { useState } from "react";
import { Bot, Hash } from "lucide-react";
import { createChannel, type Participant } from "../../api";
import { PersonAvatar } from "./panels";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Create-a-channel dialog. Owns its own form state (name + selected members); on success it
// hands the new channel id back so the parent can reload + select it, and surfaces any error
// via onNotice. `me` is always included as a member.
export function NewChannelDialog({
  open,
  onOpenChange,
  others,
  me,
  onCreated,
  onNotice,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  others: Participant[];
  me: Participant | undefined;
  onCreated: (channelId: string) => void;
  onNotice: (msg: string) => void;
}) {
  const [newName, setNewName] = useState("");
  const [newMembers, setNewMembers] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  async function submit() {
    const name = newName.trim();
    if (!name || !me) {
      onNotice("Channel name is required.");
      return;
    }
    setCreating(true);
    try {
      const handles = [...new Set([me.handle, ...newMembers])]; // always include yourself
      const ch = await createChannel({ name, kind: "channel", memberHandles: handles });
      onOpenChange(false);
      setNewName("");
      setNewMembers([]);
      onCreated(ch.id);
    } catch (e) {
      onNotice(String((e as Error).message ?? e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a channel</DialogTitle>
          <DialogDescription>
            Channels are where your team and agents work together.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-channel-name">Name</Label>
            <div className="relative">
              <Hash className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="new-channel-name"
                data-testid="new-channel-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. deploys"
                className="pl-8"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Members (you're always included)</Label>
            <div className="max-h-52 space-y-0.5 overflow-y-auto rounded-lg border p-1">
              {others.map((p) => {
                const on = newMembers.includes(p.handle);
                return (
                  <label
                    key={p.id}
                    data-testid="member-option"
                    className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={on}
                      onChange={() =>
                        setNewMembers((m) =>
                          on ? m.filter((h) => h !== p.handle) : [...m, p.handle],
                        )
                      }
                    />
                    <PersonAvatar name={p.display_name} handle={p.handle} size="sm" />
                    <span className="flex items-center gap-1">
                      @{p.handle}
                      {p.kind === "agent" && <Bot className="size-3.5 text-primary" />}
                    </span>
                  </label>
                );
              })}
              {others.length === 0 && (
                <div className="px-2 py-3 text-sm text-muted-foreground">
                  No one else yet.
                </div>
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button data-testid="create-channel-button" onClick={submit} disabled={creating}>
            {creating ? "Creating…" : "Create channel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
