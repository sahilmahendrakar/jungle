import { Bot, Hash, LogOut, MessagesSquare, PanelLeftClose } from "lucide-react";
import type { Channel, Participant, Membership } from "../../api";
import { firebaseEnabled } from "../../firebase";
import { EmptyHint, NavItem, PersonAvatar, SectionHeader } from "./panels";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// The left nav shell: workspace header, Threads/Channels/DMs/People lists, and the user footer.
// Desktop (md+): in-flow, collapsible via a drag-resizable width. Mobile (<md): a fixed off-canvas
// drawer toggled by `drawerOpen`. Purely presentational — every action is a callback.
export function Sidebar({
  rooms,
  dms,
  others,
  selected,
  me,
  threadsListOpen,
  totalThreadUnread,
  isDesktop,
  sidebarOpen,
  drawerOpen,
  resizing,
  leftWidth,
  personByHandle,
  dmChannelWith,
  onSelectChannel,
  onOpenDm,
  onOpenThreads,
  onNewChannel,
  onAddAgent,
  onCollapse,
  onOpenProfile,
  onOpenSettings,
  onSignOut,
  workspaceId,
  memberships,
  onSwitchWorkspace,
  onCreateWorkspace,
  onInvitePeople,
}: {
  rooms: Channel[];
  dms: Channel[];
  others: Participant[];
  selected: string | null;
  me: Participant | undefined;
  threadsListOpen: boolean;
  totalThreadUnread: number;
  isDesktop: boolean;
  sidebarOpen: boolean;
  drawerOpen: boolean;
  resizing: boolean;
  leftWidth: number;
  personByHandle: (h?: string | null) => Participant | undefined;
  dmChannelWith: (handle: string) => Channel | undefined;
  onSelectChannel: (id: string) => void;
  onOpenDm: (otherId: string) => void;
  onOpenThreads: () => void;
  onNewChannel: () => void;
  onAddAgent: () => void;
  onCollapse: () => void;
  onOpenProfile: (id: string) => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
  workspaceId?: string;
  memberships?: Membership[];
  onSwitchWorkspace?: (workspaceId: string) => void;
  onCreateWorkspace?: () => void;
  onInvitePeople?: () => void;
}) {
  return (
    <aside
      data-testid="sidebar"
      // Desktop width is driven by inline style (drag-resizable, persisted); collapsing sets it to
      // 0. Mobile keeps the fixed w-72 off-canvas drawer, so the inline style is only applied at
      // md+ (via isDesktop). The width transition is dropped mid-drag so the panel tracks the
      // pointer instead of easing behind it.
      style={isDesktop ? { width: sidebarOpen ? leftWidth : 0 } : undefined}
      className={cn(
        "shrink-0 overflow-hidden",
        // Mobile: off-canvas fixed drawer.
        "fixed inset-y-0 left-0 z-40 w-72 transition-transform duration-200 ease-in-out",
        drawerOpen ? "translate-x-0" : "-translate-x-full",
        // Desktop: in-flow (relative, so the resize handle anchors here) with the mobile transform
        // reset.
        "md:relative md:z-auto md:translate-x-0",
        !resizing && "md:transition-[width] md:duration-200 md:ease-in-out",
      )}
    >
      <div
        className="flex h-full w-72 flex-col bg-sidebar text-sidebar-foreground"
        style={isDesktop ? { width: leftWidth } : undefined}
      >
        {/* Workspace header + switcher */}
        <div className="flex shrink-0 items-center gap-1 border-b border-sidebar-border px-3 py-3">
          <WorkspaceSwitcher
            memberships={memberships}
            activeWorkspaceId={workspaceId}
            isAdmin={me?.role === "admin"}
            onSwitch={onSwitchWorkspace}
            onCreate={onCreateWorkspace}
            onInvite={onInvitePeople}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-testid="sidebar-collapse"
                onClick={onCollapse}
                className="flex size-8 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground md:size-7"
              >
                <PanelLeftClose className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Collapse sidebar (⌘\)</TooltipContent>
          </Tooltip>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-2 py-3">
            {/* Threads: my followed threads with unread replies (participation-gated). */}
            <NavItem
              testId="threads-nav"
              active={threadsListOpen}
              onClick={onOpenThreads}
              icon={<MessagesSquare className="size-4 opacity-70" />}
              label="Threads"
              unread={totalThreadUnread > 0}
              badgeCount={totalThreadUnread}
              badgeMention={totalThreadUnread > 0}
            />

            <div className="h-3" />
            {/* Channels */}
            <SectionHeader
              label="Channels"
              actionLabel="New channel"
              onAction={onNewChannel}
              actionTestId="new-channel-toggle"
            />
            {rooms.map((c) => {
              const unread = (c.unread_count ?? 0) > 0;
              return (
                <NavItem
                  key={c.id}
                  testId="channel-item"
                  active={c.id === selected}
                  onClick={() => onSelectChannel(c.id)}
                  icon={<Hash className="size-4 opacity-70" />}
                  label={c.name}
                  unread={unread}
                  // Slack: regular channel unreads are bold-only; only a mention shows a count badge.
                  badgeCount={c.has_mention ? c.unread_count ?? 0 : 0}
                  badgeMention={c.has_mention}
                />
              );
            })}
            {rooms.length === 0 && <EmptyHint>No channels yet.</EmptyHint>}

            {/* Direct messages */}
            {dms.length > 0 && (
              <>
                <div className="h-3" />
                <SectionHeader label="Direct messages" />
                {dms.map((c) => {
                  const p = personByHandle(c.dm_with);
                  const unread = (c.unread_count ?? 0) > 0;
                  return (
                    <NavItem
                      key={c.id}
                      testId="channel-item"
                      active={c.id === selected}
                      onClick={() => onSelectChannel(c.id)}
                      icon={
                        <PersonAvatar
                          name={p?.display_name ?? c.dm_with ?? "?"}
                          handle={c.dm_with ?? "?"}
                          size="sm"
                        />
                      }
                      label={p?.display_name ?? c.dm_with ?? "dm"}
                      title={c.dm_with ? `@${c.dm_with}` : undefined}
                      status={p?.kind === "agent" ? p.status : undefined}
                      unread={unread}
                      // Slack: every DM unread shows a count badge (all DM messages are "to you").
                      badgeCount={c.unread_count ?? 0}
                      badgeMention={c.has_mention}
                    />
                  );
                })}
              </>
            )}

            {/* People */}
            <div className="h-3" />
            <SectionHeader
              label="People"
              actionLabel="Add agent"
              onAction={onAddAgent}
              actionTestId="add-agent-toggle"
            />
            {others.map((p) => (
              <NavItem
                key={p.id}
                testId="people-item"
                active={false}
                onClick={() => {
                  const existing = dmChannelWith(p.handle);
                  if (existing) onSelectChannel(existing.id);
                  else onOpenDm(p.id);
                }}
                icon={<PersonAvatar name={p.display_name} handle={p.handle} size="sm" />}
                label={p.display_name}
                title={`@${p.handle}`}
                status={p.kind === "agent" ? p.status : undefined}
                trailing={
                  p.kind === "agent" ? (
                    <Bot className="size-3.5 text-sidebar-foreground/50" />
                  ) : undefined
                }
              />
            ))}
            {others.length === 0 && <EmptyHint>No one else yet.</EmptyHint>}
          </div>
        </div>

        {/* User footer */}
        {me && (
          <div className="flex shrink-0 items-center gap-1 border-t border-sidebar-border px-2 py-2.5">
            <button
              data-testid="open-profile"
              onClick={() => (firebaseEnabled ? onOpenSettings() : onOpenProfile(me.id))}
              title="Profile & settings"
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-sidebar-accent"
            >
              <PersonAvatar name={me.display_name} handle={me.handle} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{me.display_name}</div>
                <div className="truncate text-xs text-sidebar-foreground/50">@{me.handle}</div>
              </div>
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-testid="switch-user"
                  onClick={onSignOut}
                  title="Switch user"
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                >
                  <LogOut className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Switch user</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    </aside>
  );
}
