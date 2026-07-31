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

// Confirm-before-delete for a single message. Same shape as DeleteChannelDialog: this owns the
// in-flight state, the parent owns the actual delete. `isAgent` only changes the wording — the
// server decides who may delete what (http/routes/messages.ts).
export function DeleteMessageDialog({
  open,
  onOpenChange,
  isAgent,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  isAgent: boolean;
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
          <DialogTitle>Delete this message?</DialogTitle>
          <DialogDescription>
            {isAgent
              ? "This removes the agent's message for everyone, along with any files and links it shared. It can't be undone — and the agent may already have acted on it."
              : "This removes the message for everyone, along with any files it carried. It can't be undone."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="confirm-delete-message"
            onClick={confirm}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : "Delete message"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
