import { Loader2 } from "lucide-react";
import { getIntegrationType } from "@jungle/shared";
import { BrandTile } from "@/lib/connections";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// Shown when "Create workflow" is clicked while the roster still uses integrations whose
// backing user connection isn't linked. A warning, not a gate — connections can be linked
// after launch too (finalize re-attempts the attach), so "Create anyway" stays available.
// `creating` is the parent's in-flight state (shared with the header Create button).
export function UnconnectedIntegrationsDialog({
  missing,
  creating = false,
  onOpenChange,
  onOpenConnections,
  onConfirm,
}: {
  // Integration keys still unlinked; null/empty = dialog closed.
  missing: string[] | null;
  creating?: boolean;
  onOpenChange: (v: boolean) => void;
  onOpenConnections: () => void;
  onConfirm: () => void;
}) {
  const open = !!missing && missing.length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Some connections aren't linked yet</DialogTitle>
          <DialogDescription>
            The team won't be able to use{" "}
            {missing && missing.length === 1 ? "this integration" : "these integrations"} until
            you connect {missing && missing.length === 1 ? "it" : "them"} — you can do that now,
            or create the workflow and connect later from Settings.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5" data-testid="unconnected-integrations-list">
          {(missing ?? []).map((k) => (
            <div
              key={k}
              className="flex items-center gap-2.5 rounded-lg border border-amber-400/50 bg-amber-50/60 px-3 py-2 dark:bg-amber-500/10"
            >
              <BrandTile brand={k} className="size-7 rounded-md" glyphClassName="size-3.5" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {getIntegrationType(k)?.name ?? k}
              </span>
              <span className="text-xs text-amber-600 dark:text-amber-400">Not connected</span>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            data-testid="unconnected-open-connections"
            onClick={() => {
              onOpenChange(false);
              onOpenConnections();
            }}
            disabled={creating}
          >
            Open connections
          </Button>
          <Button data-testid="unconnected-create-anyway" onClick={onConfirm} disabled={creating}>
            {creating && <Loader2 className="size-4 animate-spin" />}
            {creating ? "Creating team…" : "Create anyway"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
