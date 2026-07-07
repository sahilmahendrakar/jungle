import type { ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// The frame every non-chat main-column view shares (Approvals, Deliverables, Agents, Scheduled):
// the h-14 header with the mobile-drawer / collapsed-sidebar affordances, a title, optional
// header actions, and a scrollable centered body.
export function ViewShell({
  icon,
  title,
  actions,
  sidebarOpen,
  onOpenDrawer,
  onExpandSidebar,
  testId,
  children,
}: {
  icon: ReactNode;
  title: string;
  actions?: ReactNode;
  sidebarOpen: boolean;
  onOpenDrawer: () => void;
  onExpandSidebar: () => void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <main data-testid={testId} className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b px-3 md:px-5">
        {/* Mobile hamburger: opens the off-canvas drawer. Hidden on md+. */}
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
        <span className="text-muted-foreground">{icon}</span>
        <h1 className="truncate text-base font-semibold">{title}</h1>
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6">{children}</div>
      </div>
    </main>
  );
}
