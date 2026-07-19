import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./auth";
import { navigate } from "./route";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { avatarClass, initials } from "@/lib/people";
import { cn } from "@/lib/utils";
import { BrandTile, useConnections, type ConnectionState } from "@/lib/connections";
import { useSlack } from "@/lib/slack";
import {
  ArrowLeft,
  Bell,
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  LogOut,
  Mail,
  Search,
  Settings as SettingsIcon,
  Unlink,
  X,
} from "lucide-react";
import {
  notificationsEnabled,
  notificationPermission,
  requestNotificationPermission,
  setNotificationsEnabled,
} from "./lib/notifications";

// One thin connection row: brand tile + name + live status, expanding on click to the
// connect/disconnect controls (and, for GitHub, the App-installation details).
// Exported for the connections mocks/tests.
export function ConnectionRow({
  conn,
  expanded,
  onToggle,
  connecting,
  onConnect,
  onDisconnect,
}: {
  conn: ConnectionState;
  expanded: boolean;
  onToggle: () => void;
  connecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border bg-card transition-colors">
      <button
        type="button"
        onClick={onToggle}
        data-testid={`connection-row-${conn.key}`}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent/50"
      >
        <BrandTile brand={conn.key} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium leading-tight">{conn.name}</span>
          {conn.connected && conn.needsReconnect ? (
            <span className="flex items-center gap-1 text-xs text-amber-600">
              <span className="size-1.5 rounded-full bg-amber-500" />
              <span className="truncate">Reconnect needed{conn.account ? ` · ${conn.account}` : ""}</span>
            </span>
          ) : conn.connected ? (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              <span className="truncate">{conn.account || "Connected"}</span>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Not connected</span>
          )}
        </span>
        {!conn.connected ? (
          <span className="rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Connect
          </span>
        ) : conn.needsReconnect ? (
          <span
            data-testid={`connection-reconnect-badge-${conn.key}`}
            className="rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600"
          >
            Reconnect
          </span>
        ) : null}
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")}
        />
      </button>

      {expanded && (
        <div className="space-y-3 border-t bg-muted/30 px-3 py-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{conn.description}</p>

          {/* A dead OAuth grant (invalid_grant) looks "connected" but agents can't use it —
              reconnecting rides the same consent flow as connecting and revives the grant. */}
          {conn.connected && conn.needsReconnect && (
            <div
              className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
              data-testid={`settings-reconnect-${conn.key}`}
            >
              <p className="text-xs leading-relaxed text-muted-foreground">
                This connection's authorization expired, so agents can't use it right now.
                Reconnect to restore access — it takes a few seconds.
              </p>
              <Button
                data-testid={`settings-reconnect-button-${conn.key}`}
                size="sm"
                onClick={onConnect}
                disabled={connecting}
                className="gap-1.5"
              >
                {connecting ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {connecting ? "Waiting for authorization…" : `Reconnect ${conn.name}`}
              </Button>
            </div>
          )}

          {/* GitHub also surfaces its App installation state — repo access rides the App, not
              just the account link. */}
          {conn.key === "github" && conn.connected && conn.github && (
            <GithubAppDetails github={conn.github} />
          )}

          <div className="flex items-center justify-between gap-2">
            {conn.connected ? (
              !confirmUnlink ? (
                <Button
                  data-testid={`settings-disconnect-${conn.key}`}
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmUnlink(true)}
                  className="gap-1.5 text-muted-foreground hover:text-destructive"
                >
                  <Unlink className="size-3.5" />
                  Disconnect
                </Button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Agents using this connection will lose access.
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmUnlink(false)}>
                    Cancel
                  </Button>
                  <Button
                    data-testid={`settings-disconnect-${conn.key}-confirm`}
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setConfirmUnlink(false);
                      onDisconnect();
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
              )
            ) : (
              <Button
                data-testid={`settings-connect-${conn.key}`}
                size="sm"
                onClick={onConnect}
                disabled={connecting}
                className="gap-1.5"
              >
                {connecting ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {connecting ? "Waiting for authorization…" : `Connect ${conn.name}`}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// GitHub App installation status inside the GitHub row's expansion: agents can only work on
// repos where the Jungle GitHub App is installed, which is separate from the account link.
function GithubAppDetails({ github }: { github: NonNullable<ConnectionState["github"]> }) {
  const needsInstall = github.repoCount === 0;
  return (
    <div className="rounded-lg border bg-background p-3" data-testid="settings-github-app">
      {needsInstall ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Agents can only work on repositories where the{" "}
            <span className="font-medium text-foreground">Jungle GitHub App</span> is installed.
            {github.installationCount > 0
              ? " You have an installation, but no repositories are granted yet."
              : " Install it on your account or organization to add repos."}
          </p>
          {github.installUrl && (
            <Button asChild size="sm" className="gap-1.5">
              <a
                href={github.installUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="settings-install-github-app"
              >
                Install GitHub App
                <ExternalLink className="size-3 opacity-60" />
              </a>
            </Button>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 text-xs text-emerald-600">
            <Check className="size-3.5 shrink-0" />
            {github.repoCount} repositor{github.repoCount === 1 ? "y" : "ies"} available to agents
          </div>
          {github.installUrl && (
            <Button variant="outline" size="sm" asChild className="h-7 gap-1.5 text-xs">
              <a
                href={github.installUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="settings-manage-github-app"
              >
                Manage access
                <ExternalLink className="size-3 opacity-60" />
              </a>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// The account + connections settings body, shared by the right-panel `SettingsPanel` and the
// legacy full-page `/settings` route. Pulls the current user from the auth context, so it must
// render under an AuthProvider (i.e. only in Firebase mode).
// Desktop notifications: permission request + on/off preference (lib/notifications.ts owns the
// mechanics; the rules of what pings — DMs, mentions, approvals — live in App).
function NotificationsSection() {
  const [enabled, setEnabled] = useState(notificationsEnabled());
  const [perm, setPerm] = useState(notificationPermission());
  const active = enabled && perm === "granted";

  async function toggle() {
    if (active) {
      setNotificationsEnabled(false);
      setEnabled(false);
      return;
    }
    const p = await requestNotificationPermission();
    setPerm(p);
    if (p === "granted") {
      setNotificationsEnabled(true);
      setEnabled(true);
    }
  }

  return (
    <section className="mt-8 space-y-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Notifications
      </h2>
      <div className="rounded-xl border bg-card p-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Bell className="size-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Desktop notifications</div>
            <div className="text-xs text-muted-foreground">
              {perm === "unsupported"
                ? "Not supported in this browser."
                : perm === "denied"
                  ? "Blocked in your browser settings — allow notifications for this site to enable."
                  : active
                    ? "On — DMs, mentions, and approvals ping you when you're not looking."
                    : "Get pinged for DMs, mentions, and approvals when the tab isn't focused."}
            </div>
          </div>
          <Button
            data-testid="settings-notifications-toggle"
            onClick={toggle}
            disabled={perm === "unsupported" || perm === "denied"}
            size="sm"
            variant={active ? "outline" : "default"}
            className="shrink-0"
          >
            {active ? "Turn off" : "Turn on"}
          </Button>
        </div>
      </div>
    </section>
  );
}

// Workspace-level Slack install (distinct from the per-user Connections list): one Slack team per
// workspace, connected by an admin. Once connected, any channel can be mirrored from its header.
function SlackWorkspaceSection({ isAdmin }: { isAdmin: boolean }) {
  const slack = useSlack();
  const installed = slack.status.installed && slack.status.status !== "revoked";
  const revoked = slack.status.installed && slack.status.status === "revoked";
  return (
    <section className="mt-8 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Slack</h2>
        {slack.loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>
      <div className="flex items-center gap-3 rounded-xl border bg-card p-4">
        <BrandTile brand="slack" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            {installed ? slack.status.teamName || "Slack workspace" : "Mirror channels to Slack"}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {installed
              ? "Connected — link a channel from its header to start mirroring."
              : revoked
                ? "Reconnect needed — the Slack token was revoked."
                : "Two-way channel mirroring. @mention agents from Slack."}
          </div>
        </div>
        {installed ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={!isAdmin}
            onClick={() => void slack.disconnect()}
            className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Unlink className="size-3.5" />
            Disconnect
          </Button>
        ) : (
          <Button size="sm" disabled={!isAdmin || slack.connecting} onClick={() => void slack.connect()}>
            {slack.connecting ? <Loader2 className="size-3.5 animate-spin" /> : revoked ? "Reconnect" : "Connect"}
          </Button>
        )}
      </div>
      {!isAdmin && (
        <p className="text-xs text-muted-foreground">Only a workspace admin can connect Slack.</p>
      )}
      {slack.error && <p className="text-sm text-destructive">{slack.error}</p>}
    </section>
  );
}

function SettingsContent({ focusConnections = false }: { focusConnections?: boolean }) {
  const { me, signOut } = useAuth();
  const profile = me?.profile;
  // Resolve the active membership (the workspace stored by AuthGate), falling back to the first.
  const activeWsId = typeof localStorage !== "undefined" ? localStorage.getItem("jungle.workspace") : null;
  const membership =
    me?.memberships.find((m) => m.workspace.id === activeWsId) ?? me?.memberships[0];
  const participant = membership?.participant;

  const conns = useConnections();
  const [query, setQuery] = useState("");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // When opened from an integration deep-link (e.g. a workflow's connections panel), land
  // directly on the Connections section instead of the account block at the top.
  const connectionsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusConnections) connectionsRef.current?.scrollIntoView({ block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conns.connections;
    return conns.connections.filter(
      (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    );
  }, [conns.connections, query]);

  if (!participant) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-6">
      {/* Account */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Account
        </h2>
        <div className="flex items-center gap-3 rounded-xl border bg-card p-4">
          <Avatar className="size-14 rounded-xl">
            {profile?.picture && <AvatarImage src={profile.picture} alt={participant.display_name} />}
            <AvatarFallback className={cn(avatarClass(participant.handle), "rounded-xl text-base")}>
              {initials(participant.display_name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{participant.display_name}</div>
            <div className="truncate text-sm text-muted-foreground">@{participant.handle}</div>
            {profile?.email && (
              <div className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                <Mail className="size-3 shrink-0" />
                {profile.email}
              </div>
            )}
          </div>
        </div>
      </section>

      <NotificationsSection />

      {/* Connections: every account link agents can build on — one searchable list; each row
          expands for details. Integrations attach these per-agent (agent profile → Integrations). */}
      <section ref={connectionsRef} className="mt-8 scroll-mt-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Connections
          </h2>
          {conns.loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search connections…"
            data-testid="connections-search"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Connect your accounts once here; then give any agent an integration built on them.
        </p>
        <div className="space-y-2">
          {visible.map((c) => (
            <ConnectionRow
              key={c.key}
              conn={c}
              expanded={expandedKey === c.key}
              onToggle={() => setExpandedKey((k) => (k === c.key ? null : c.key))}
              connecting={conns.connecting === c.key}
              onConnect={() => void conns.connect(c.key)}
              onDisconnect={() => void conns.disconnect(c.key)}
            />
          ))}
          {!visible.length && (
            <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">
              No connections match “{query}”.
            </p>
          )}
        </div>
      </section>

      {conns.error && (
        <p className="mt-4 text-sm text-destructive" data-testid="settings-error">
          {conns.error}
        </p>
      )}

      <SlackWorkspaceSection isAdmin={participant.role === "admin"} />

      <section className="mt-10 border-t pt-6">
        <Button
          data-testid="settings-sign-out"
          onClick={() => signOut()}
          variant="ghost"
          className="w-full justify-start gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <LogOut className="size-4" />
          Sign out
        </Button>
      </section>
    </div>
  );
}

// Settings as a right-panel view (contextual sidebar). Shares its body with the full-page route.
// `focusConnections` scrolls straight to the Connections section — used by integration
// deep-links (workflow pages) where the user clearly wants to manage account links.
export function SettingsPanel({
  onClose,
  focusConnections = false,
}: {
  onClose: () => void;
  focusConnections?: boolean;
}) {
  return (
    <div data-testid="settings-panel" className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <SettingsIcon className="size-4 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate font-semibold">Settings</h2>
        <Button
          variant="ghost"
          size="icon"
          data-testid="settings-close"
          aria-label="Close settings"
          onClick={onClose}
          className="size-8 shrink-0 text-muted-foreground"
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SettingsContent focusConnections={focusConnections} />
      </div>
    </div>
  );
}

// Full-page settings route (kept for deep links / non-panel navigation).
export function Settings() {
  return (
    <main className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Button
          variant="ghost"
          size="icon"
          data-testid="settings-back"
          onClick={() => navigate("/")}
          className="size-8 shrink-0"
          aria-label="Back to Jungle"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <h1 className="text-base font-semibold">Settings</h1>
      </header>
      <SettingsContent />
    </main>
  );
}
