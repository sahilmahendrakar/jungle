import {
  Hash,
  Home,
  LogOut,
  MessagesSquare,
  Moon,
  MonitorSmartphone,
  PanelLeftClose,
  Plus,
  Search,
  Sun,
  Users,
  Workflow,
} from "lucide-react";
import type { Channel, Participant, Membership } from "../../api";
import { firebaseEnabled } from "../../firebase";
import { useTheme, type ThemePreference } from "../../theme";
import { EmptyHint, NavItem, PersonAvatar, SectionHeader } from "./panels";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Cycle light -> dark -> system with one button (label shows the CURRENT preference).
const THEME_CYCLE: Record<ThemePreference, ThemePreference> = {
  light: "dark",
  dark: "system",
  system: "light",
};

function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const icon =
    preference === "dark" ? (
      <Moon className="size-4" />
    ) : preference === "light" ? (
      <Sun className="size-4" />
    ) : (
      <MonitorSmartphone className="size-4" />
    );
  const label =
    preference === "system" ? "Theme: system" : preference === "dark" ? "Theme: dark" : "Theme: light";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          data-testid="theme-toggle"
          onClick={() => setPreference(THEME_CYCLE[preference])}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label} — click to change</TooltipContent>
    </Tooltip>
  );
}

// The left nav shell: workspace header, Threads/Channels/DMs lists, and the user footer.
// Desktop (md+): in-flow, collapsible via a drag-resizable width. Mobile (<md): a fixed off-canvas
// drawer toggled by `drawerOpen`. Purely presentational — every action is a callback.
export function Sidebar({
  rooms,
  dms,
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
  onSelectChannel,
  onOpenThreads,
  onOpenHome,
  homeActive,
  homeBadge,
  onOpenWorkflows,
  workflowsActive,
  onOpenTeam,
  teamActive,
  onOpenEnvironments,
  environmentsActive,
  onOpenSearch,
  workingChannelIds,
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
  onSelectChannel: (id: string) => void;
  onOpenThreads: () => void;
  onOpenHome: () => void;
  homeActive: boolean;
  homeBadge: number; // things waiting on the user (pending approvals + stalled runs)
  onOpenWorkflows: () => void;
  workflowsActive: boolean;
  onOpenTeam: () => void;
  teamActive: boolean;
  onOpenEnvironments: () => void;
  environmentsActive: boolean;
  onOpenSearch: () => void;
  workingChannelIds: Set<string>; // channels with a turn currently running (pulsing dot)
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
          {/* Bottom padding ≈ the floating CTA's height, so the last list item can
              still be scrolled clear of it. */}
          <div className="px-2 pb-14 pt-3">
            {/* Search: the ⌘K palette (messages, channels, people). */}
            <NavItem
              testId="search-nav"
              active={false}
              onClick={onOpenSearch}
              icon={<Search className="size-4 opacity-70" />}
              label="Search"
              trailing={
                <kbd className="hidden rounded border border-sidebar-border px-1 font-mono text-[10px] text-sidebar-foreground/40 md:inline">
                  ⌘K
                </kbd>
              }
            />
            {/* Home: the attention inbox — approvals + stalled runs ("needs you"), deliverables,
                live activity, upcoming runs. The badge is the ONE number to check. */}
            <NavItem
              testId="home-nav"
              active={homeActive}
              onClick={onOpenHome}
              icon={<Home className="size-4 opacity-70" />}
              label="Home"
              unread={homeBadge > 0}
              badgeCount={homeBadge}
              badgeMention={homeBadge > 0}
            />
            {/* Workflows: teams of agents on a trigger, plus scheduled tasks (absorbs Scheduled). */}
            <NavItem
              testId="workflows-nav"
              active={workflowsActive}
              onClick={onOpenWorkflows}
              icon={<Workflow className="size-4 opacity-70" />}
              label="Workflows"
            />
            {/* Team: every agent (grouped by workflow), live status, what each is doing. */}
            <NavItem
              testId="team-nav"
              active={teamActive}
              onClick={onOpenTeam}
              icon={<Users className="size-4 opacity-70" />}
              label="Team"
            />
            {/* Threads moved out of the nav (2026-07-17): unread thread replies surface on Home
                instead — one attention surface, not two. The Threads view itself still exists
                (opened from Home's row); these props stay wired for it. */}
            {threadsListOpen && (
              <NavItem
                testId="threads-nav"
                active
                onClick={onOpenThreads}
                icon={<MessagesSquare className="size-4 opacity-70" />}
                label="Threads"
                unread={totalThreadUnread > 0}
                badgeCount={totalThreadUnread}
                badgeMention={totalThreadUnread > 0}
              />
            )}

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
                  working={workingChannelIds.has(c.id)}
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
          </div>
        </div>

        {/* Create agent: the primary CTA, floating at the bottom of the sidebar. The
            negative top margin pulls it up over the scroll area (net layout space ≈ 0),
            so the list scrolls away behind it with no gap. pointer-events-none on the
            wrapper keeps the list items behind the transparent margins interactive. */}
        <div className="pointer-events-none relative z-10 -mt-[46px] shrink-0 px-3 pb-2.5">
          <Button
            data-testid="add-agent-toggle"
            onClick={onAddAgent}
            className="pointer-events-auto h-9 w-full rounded-full text-sm font-semibold shadow-md"
          >
            <Plus />
            Create agent
          </Button>
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
            {/* Environments (self-hosted devices) lives in the footer now — it's setup, not daily. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-testid="environments-nav"
                  onClick={onOpenEnvironments}
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
                    environmentsActive ? "text-sidebar-foreground" : "text-sidebar-foreground/70",
                  )}
                >
                  <MonitorSmartphone className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Environments — your devices that run agents</TooltipContent>
            </Tooltip>
            <ThemeToggle />
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
