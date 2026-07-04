import { Hash, MoreVertical, PanelLeft, Trash2, UserPlus, Users } from "lucide-react";
import type { Channel, Participant } from "../../api";
import { PersonAvatar } from "./panels";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// The conversation header bar: mobile menu / desktop sidebar-expand affordances, the channel or DM
// title (DMs link to the other participant's profile), and — for channels — the member count +
// settings menu (members / delete). Presentational; every action is a callback.
export function ChannelHeader({
  channel,
  headerTitle,
  sidebarOpen,
  memberCount,
  personByHandle,
  onOpenDrawer,
  onExpandSidebar,
  onOpenProfile,
  onOpenMembers,
  onDeleteChannel,
}: {
  channel: Channel | undefined;
  headerTitle: string | null;
  sidebarOpen: boolean;
  memberCount: number;
  personByHandle: (h?: string | null) => Participant | undefined;
  onOpenDrawer: () => void;
  onExpandSidebar: () => void;
  onOpenProfile: (id: string) => void;
  onOpenMembers: () => void;
  onDeleteChannel: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2.5 border-b px-3 md:px-5">
      {/* Mobile hamburger: opens the off-canvas drawer. Hidden on md+ (desktop uses the persisted
          collapse toggle below instead). */}
      <Button
        variant="ghost"
        size="icon"
        data-testid="sidebar-toggle"
        aria-label="Open menu"
        onClick={onOpenDrawer}
        className="-ml-1 size-9 shrink-0 text-muted-foreground md:hidden"
      >
        <PanelLeft className="size-5" />
      </Button>
      {!sidebarOpen && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              data-testid="sidebar-expand"
              onClick={onExpandSidebar}
              className="-ml-2 hidden size-8 shrink-0 text-muted-foreground md:inline-flex"
            >
              <PanelLeft className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open sidebar (⌘\)</TooltipContent>
        </Tooltip>
      )}
      {channel ? (
        <>
          {channel.kind === "dm" ? (
            <button
              data-testid="dm-header-profile"
              onClick={() => {
                const other = personByHandle(channel.dm_with);
                if (other) onOpenProfile(other.id);
              }}
              className="flex min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1 -mx-1.5 transition-colors hover:bg-accent"
              title="View profile"
            >
              <PersonAvatar
                name={personByHandle(channel.dm_with)?.display_name ?? channel.dm_with ?? "?"}
                handle={channel.dm_with ?? "?"}
                size="sm"
              />
              <h2 className="truncate font-semibold">{headerTitle}</h2>
            </button>
          ) : (
            <>
              <Hash className="size-5 text-muted-foreground" />
              <h2 className="truncate font-semibold">{headerTitle}</h2>
            </>
          )}

          {channel.kind !== "dm" && (
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                data-testid="members-button"
                onClick={onOpenMembers}
                className="h-8 gap-1.5 rounded-full px-2.5 text-muted-foreground"
                title="Members"
              >
                <Users className="size-4" />
                <span className="text-xs font-medium tabular-nums">{memberCount}</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground"
                    data-testid="channel-menu"
                    title="Channel settings"
                  >
                    <MoreVertical className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem data-testid="menu-members" onClick={onOpenMembers}>
                    <UserPlus className="size-4" />
                    Members
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    data-testid="menu-delete-channel"
                    onClick={onDeleteChannel}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="size-4" />
                    Delete channel
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </>
      ) : (
        <h2 className="font-semibold text-muted-foreground">Select or create a channel</h2>
      )}
    </header>
  );
}
