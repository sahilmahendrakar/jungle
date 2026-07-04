import { Check, ChevronsUpDown, Plus, UserPlus } from "lucide-react";
import type { Membership } from "../../api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// The sidebar header for Firebase mode: shows the active workspace and a dropdown to switch
// workspaces, create a new one, and (admins) invite people. Falls back to a static "Jungle"
// header when there are no memberships (dev / ?as= mode).
export function WorkspaceSwitcher({
  memberships,
  activeWorkspaceId,
  isAdmin,
  onSwitch,
  onCreate,
  onInvite,
}: {
  memberships?: Membership[];
  activeWorkspaceId?: string;
  isAdmin: boolean;
  onSwitch?: (workspaceId: string) => void;
  onCreate?: () => void;
  onInvite?: () => void;
}) {
  const active = memberships?.find((m) => m.workspace.id === activeWorkspaceId);

  // Dev mode (no memberships): the original static header.
  if (!memberships || memberships.length === 0 || !onSwitch) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <img src="/icon-192.png" alt="Jungle" className="size-8 rounded-lg shadow-sm" />
        <div className="truncate font-bold leading-tight">{active?.workspace.name ?? "Jungle"}</div>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-testid="workspace-switcher"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-sidebar-accent"
        >
          <img src="/icon-192.png" alt="" className="size-8 rounded-lg shadow-sm" />
          <div className="min-w-0 flex-1 truncate font-bold leading-tight">
            {active?.workspace.name ?? "Workspace"}
          </div>
          <ChevronsUpDown className="size-4 shrink-0 text-sidebar-foreground/50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {memberships.map((m) => (
          <DropdownMenuItem
            key={m.workspace.id}
            onClick={() => onSwitch(m.workspace.id)}
            className="gap-2"
          >
            <span className="min-w-0 flex-1 truncate">{m.workspace.name}</span>
            {m.workspace.id === activeWorkspaceId && <Check className="size-4 text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {isAdmin && onInvite && (
          <DropdownMenuItem onClick={onInvite} className="gap-2">
            <UserPlus className="size-4" />
            Invite people
          </DropdownMenuItem>
        )}
        {onCreate && (
          <DropdownMenuItem onClick={onCreate} className="gap-2">
            <Plus className="size-4" />
            Create workspace
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
