import { useState } from "react";
import type { Workflow } from "../../api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// Confirm-before-delete dialog for a workflow. Owns the in-flight `deleting` state; the actual
// delete (and post-delete navigation) is the parent's async `onConfirm`. Copy branches on draft
// vs live because the backend treats them differently: a draft's roster agents only ever existed
// for the draft and are deleted with it, while a live workflow's agents and home channel survive
// (deleting them is an explicit, separate act).
export function DeleteWorkflowDialog({
  workflow,
  liveRun = false,
  onOpenChange,
  onConfirm,
}: {
  workflow: Workflow | null;
  liveRun?: boolean;
  onOpenChange: (v: boolean) => void;
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

  const draft = workflow?.status === "draft";
  return (
    <Dialog open={!!workflow} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Delete {workflow?.emoji ? `${workflow.emoji} ` : ""}{workflow?.name}?
          </DialogTitle>
          <DialogDescription>
            {draft
              ? "This permanently deletes the draft and the placeholder agents on its roster. This can't be undone."
              : "This permanently deletes the workflow, its runs, and its trigger. The agents and the home channel stay — delete them separately if you don't need them. This can't be undone."}
            {!draft && liveRun ? " A run is currently in progress and will be abandoned." : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="confirm-delete-workflow"
            onClick={confirm}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : "Delete workflow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
