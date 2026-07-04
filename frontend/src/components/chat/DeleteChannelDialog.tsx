import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// Confirm-before-delete dialog for a channel. Owns the in-flight `deleting` state; the actual
// delete (and post-delete navigation) is the parent's async `onConfirm`.
export function DeleteChannelDialog({
  open,
  onOpenChange,
  channelName,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  channelName: string | undefined;
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete #{channelName}?</DialogTitle>
          <DialogDescription>
            This permanently deletes the channel and all of its messages for everyone. This can't
            be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="confirm-delete-channel"
            onClick={confirm}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : "Delete channel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
