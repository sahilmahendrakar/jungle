import { useMemo, useState } from "react";
import { ChevronDown, Loader2, Plus, Search, X } from "lucide-react";
import {
  INTEGRATION_TYPES,
  connectionForIntegration,
  type IntegrationType,
} from "../../api";
import { RepoCombobox } from "../../RepoCombobox";
import { BrandTile, type ConnectionsApi, type ConnectionState } from "@/lib/connections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface IntegrationDraft {
  key: string;
  config: Record<string, string>;
}

// Approval values live as strings in local drafts and booleans in server-loaded configs —
// anything but an explicit false/"false" means "ask first" (the default).
function approvalOn(v: unknown): boolean {
  return String(v ?? "true") !== "false";
}

// The approval-toggle config key per integration (gmail predates the generic one).
function approvalKey(type: IntegrationType): string | null {
  if (type.readOnly) return null; // read-only tools — nothing to approve
  if (type.key === "gmail") return "requireSendApproval";
  if (type.key === "github") return null; // gated by the agent's tool-permission mode instead
  return "requireApproval";
}

// Whether attaching this integration HARD-requires the user's connection: gmail and the
// remote-MCP ones bind to it server-side (the backend 400s without it). GitHub does not —
// agent repo access rides the GitHub App installation, so the user's GitHub link only powers
// the repo picker (we still nudge to connect, but allow manual owner/name entry).
function connectionRequired(type: IntegrationType): boolean {
  return type.key === "gmail" || type.connection === "oauth";
}

// Canonical form of one draft's user-editable settings, for change detection. Server-loaded
// configs carry resolved fields (backingParticipantId, email, real booleans) that the editor
// never touches — comparing raw JSON against string drafts made the Save button think clean
// saves were still dirty (and vice versa). Only typed config fields + the approval toggle count.
export function integrationFingerprint(entry: IntegrationDraft): string {
  const type = INTEGRATION_TYPES.find((t) => t.key === entry.key);
  const parts: string[] = [entry.key];
  for (const f of type?.configFields ?? []) parts.push(`${f.key}=${String(entry.config[f.key] ?? "").trim()}`);
  if (type?.key === "github") {
    // GitHub's optional commit identity (see the github entry in INTEGRATION_TYPES) is
    // user-editable like the typed fields, so it counts for dirty detection too.
    parts.push(`authorName=${String(entry.config.authorName ?? "").trim()}`);
    parts.push(`authorEmail=${String(entry.config.authorEmail ?? "").trim()}`);
  }
  const apKey = type ? approvalKey(type) : null;
  if (apKey) parts.push(`${apKey}=${approvalOn(entry.config[apKey])}`);
  return parts.join("\0");
}

export function integrationsFingerprint(list: IntegrationDraft[]): string {
  return [...list]
    .map(integrationFingerprint)
    .sort()
    .join("");
}

// Pre-save validation shared by the create dialog and the profile panel: every attached
// integration needs its backing connection linked and its required fields filled. Returns a
// user-facing message, or null when everything is saveable.
export function validateIntegrations(list: IntegrationDraft[], connections: ConnectionsApi): string | null {
  for (const entry of list) {
    const type = INTEGRATION_TYPES.find((t) => t.key === entry.key);
    if (!type) continue;
    const connType = connectionForIntegration(entry.key);
    const conn = connType ? connections.byKey[connType.key] : undefined;
    if (conn && !conn.connected && connectionRequired(type)) {
      return `${type.name}: connect your ${conn.name} account first (or remove the integration).`;
    }
    for (const f of type.configFields) {
      if (!String(entry.config[f.key] ?? "").trim()) return `${type.name}: ${f.label} is required.`;
    }
    if (type.key === "github") {
      const email = String(entry.config.authorEmail ?? "").trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return `${type.name}: commit author email must be a valid email address.`;
      }
    }
  }
  return null;
}

// One-line summary shown on the collapsed row: the essential config (repo / account) or a
// warning that setup is still needed.
function rowSummary(
  type: IntegrationType,
  config: Record<string, string>,
  conn: ConnectionState | undefined,
): { text: string; warn: boolean } {
  if (conn && !conn.connected && connectionRequired(type)) {
    return { text: `Connect ${conn.name} to use`, warn: true };
  }
  if (type.key === "github") {
    return config.repo ? { text: config.repo, warn: false } : { text: "Choose a repository", warn: true };
  }
  const account = config.email || conn?.account || "";
  const key = approvalKey(type);
  const approval = key ? (approvalOn(config[key]) ? "asks before changes" : "acts without asking") : "";
  const parts = [account, approval].filter(Boolean);
  return { text: parts.join(" · ") || "Ready", warn: false };
}

// GitHub-only "Advanced" settings: the agent's git commit identity (config.authorName /
// config.authorEmail). Optional — when set, the agent's commits are authored with this name/email.
// Pointing the email at a real GitHub account (its `12345+login@users.noreply.github.com` noreply
// works) makes GitHub attribute the commits to that account; the default identity
// (<handle>@agents.jungle.dev) shows as unverified. Starts open when values are already set (e.g.
// editing a configured agent from its profile).
function GithubAdvanced({
  config,
  onChange,
}: {
  config: Record<string, string>;
  onChange: (config: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState(() => !!(config.authorName || config.authorEmail));
  return (
    <div className="space-y-2 border-t border-dashed pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="github-advanced-toggle"
        className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
        Advanced
      </button>
      {open && (
        <div className="space-y-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Commit author name</Label>
            <Input
              value={config.authorName ?? ""}
              placeholder="e.g. Sahil Mahendrakar"
              data-testid="github-author-name"
              onChange={(e) => onChange({ ...config, authorName: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Commit author email</Label>
            <Input
              value={config.authorEmail ?? ""}
              placeholder="12345+you@users.noreply.github.com"
              data-testid="github-author-email"
              onChange={(e) => onChange({ ...config, authorEmail: e.target.value })}
            />
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            The agent's commits show this author. Use an email linked to a GitHub account (its
            noreply address works) so commits are attributed to it — otherwise GitHub can't verify
            an account for the commit.
          </p>
        </div>
      )}
    </div>
  );
}

// One attached integration: a thin row (brand tile + name + summary) that expands on click to
// its settings — config fields, connection status with an inline popup connect, and the
// write-approval toggle.
function IntegrationRow({
  type,
  config,
  connections,
  expanded,
  onToggle,
  onChange,
  onRemove,
}: {
  type: IntegrationType;
  config: Record<string, string>;
  connections: ConnectionsApi;
  expanded: boolean;
  onToggle: () => void;
  onChange: (config: Record<string, string>) => void;
  onRemove: () => void;
}) {
  const connType = connectionForIntegration(type.key);
  const conn = connType ? connections.byKey[connType.key] : undefined;
  const summary = rowSummary(type, config, conn);
  const apKey = approvalKey(type);
  const connecting = conn ? connections.connecting === conn.key : false;

  return (
    <div
      className={cn("overflow-hidden rounded-lg border bg-card", expanded && "ring-1 ring-primary/20")}
      data-testid={`integration-row-${type.key}`}
    >
      <div className="group flex items-center gap-2.5 pr-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          data-testid={`integration-toggle-${type.key}`}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-2.5 text-left hover:bg-accent/40"
        >
          <BrandTile brand={type.key} className="size-7 rounded-md" glyphClassName="size-3.5" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium leading-tight">{type.name}</span>
            <span
              className={cn(
                "block truncate text-[11px] leading-tight",
                summary.warn ? "text-amber-600" : "text-muted-foreground",
              )}
            >
              {summary.text}
            </span>
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
          onClick={onRemove}
          data-testid={`integration-remove-${type.key}`}
          aria-label={`Remove ${type.name}`}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {expanded && (
        <div className="space-y-2.5 border-t bg-muted/30 p-2.5">
          {/* Connection gate: gmail + remote-MCP integrations bind to the per-user connection,
              so without it there's nothing to configure. Offer the popup connect right here —
              no detour to Settings mid-flow. GitHub instead gets a soft nudge below. */}
          {conn && !conn.connected && connectionRequired(type) ? (
            <div className="space-y-2">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {type.name} needs your{" "}
                <span className="font-medium text-foreground">{conn.name}</span> account. Connect it
                once — it's saved to your profile for any agent.
              </p>
              <Button
                size="sm"
                className="h-7 gap-1.5 text-xs"
                disabled={connecting}
                data-testid={`integration-connect-${type.key}`}
                onClick={() => void connections.connect(conn.key)}
              >
                {connecting && <Loader2 className="size-3 animate-spin" />}
                {connecting ? "Waiting for authorization…" : `Connect ${conn.name}`}
              </Button>
            </div>
          ) : (
            <>
              {conn?.connected && type.configFields.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Using{" "}
                  <span className="font-medium text-foreground">
                    {config.email || conn.account || `your ${conn.name}`}
                  </span>
                </p>
              )}
              {/* Soft nudge (github): usable without the user's link, but connecting unlocks
                  the searchable repo picker. */}
              {conn && !conn.connected && !connectionRequired(type) && (
                <div className="flex items-center justify-between gap-2 rounded-md border border-dashed px-2 py-1.5">
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Connect {conn.name} to search your repositories.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 shrink-0 gap-1 px-2 text-[11px]"
                    disabled={connecting}
                    data-testid={`integration-connect-${type.key}`}
                    onClick={() => void connections.connect(conn.key)}
                  >
                    {connecting && <Loader2 className="size-3 animate-spin" />}
                    {connecting ? "Waiting…" : "Connect"}
                  </Button>
                </div>
              )}
              {type.configFields.map((field) => (
                <div key={field.key} className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{field.label}</Label>
                  {type.key === "github" && field.key === "repo" ? (
                    <RepoCombobox
                      value={config[field.key] ?? ""}
                      onChange={(v) => onChange({ ...config, [field.key]: v })}
                    />
                  ) : (
                    <Input
                      value={config[field.key] ?? ""}
                      placeholder={field.placeholder}
                      onChange={(e) => onChange({ ...config, [field.key]: e.target.value })}
                    />
                  )}
                </div>
              ))}
              {type.key === "github" && <GithubAdvanced config={config} onChange={onChange} />}
              {apKey && (
                <label className="flex items-center gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    data-testid={`${type.key}-require-approval`}
                    checked={approvalOn(config[apKey])}
                    onChange={(e) => onChange({ ...config, [apKey]: e.target.checked ? "true" : "false" })}
                  />
                  {type.key === "gmail"
                    ? "Require my approval before sending or modifying email"
                    : `Require my approval before this agent makes changes in ${type.name}`}
                </label>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Attach/configure/remove an agent's integrations — used by both the create-agent dialog and
// the agent profile panel. Integrations are per-agent; each is built on one of the user's
// per-account connections (Settings → Connections), which can also be linked inline here.
//
// `disabledKeys` hides an integration from the picker for the current context — e.g. the GitHub
// repo integration is meaningless (and would collide) when the agent runs unsandboxed in the
// user's own repo, so the create dialog passes it for an unsandboxed selected device.
export function IntegrationsEditor({
  value,
  onChange,
  connections,
  disabledKeys,
}: {
  value: IntegrationDraft[];
  onChange: (v: IntegrationDraft[]) => void;
  connections: ConnectionsApi;
  disabledKeys?: Set<string>;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const attachedKeys = new Set(value.map((v) => v.key));

  const available = useMemo(() => {
    const q = query.trim().toLowerCase();
    return INTEGRATION_TYPES.filter((t) => !attachedKeys.has(t.key) && !disabledKeys?.has(t.key)).filter(
      (t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, value, disabledKeys]);

  function add(type: IntegrationType) {
    if (type.comingSoon || disabledKeys?.has(type.key)) return;
    onChange([...value, { key: type.key, config: {} }]);
    setPickerOpen(false);
    setQuery("");
    setExpandedKey(type.key); // open the new row so its setup (repo pick / connect) is in view
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Integrations</Label>
        <Popover
          open={pickerOpen}
          onOpenChange={(o) => {
            setPickerOpen(o);
            if (!o) setQuery("");
          }}
        >
          <PopoverTrigger asChild>
            <Button variant="secondary" size="sm" className="h-7 gap-1 text-xs" data-testid="add-integration">
              <Plus className="size-3.5" /> Add integration
            </Button>
          </PopoverTrigger>
          <PopoverContent portal={false} align="end" className="w-80 p-0">
            <div className="relative border-b p-2">
              <Search className="pointer-events-none absolute left-[18px] top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search integrations…"
                data-testid="integration-search"
                className="h-8 pl-8 text-sm"
              />
            </div>
            <div className="max-h-72 space-y-0.5 overflow-y-auto p-1.5">
              {available.map((t) => {
                const connType = connectionForIntegration(t.key);
                const conn = connType ? connections.byKey[connType.key] : undefined;
                return (
                  <button
                    key={t.key}
                    type="button"
                    disabled={t.comingSoon}
                    onClick={() => add(t)}
                    data-testid={`integration-option-${t.key}`}
                    className="flex w-full items-center gap-2.5 rounded-md p-2 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    <BrandTile brand={t.key} className="size-7 rounded-md" glyphClassName="size-3.5" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-sm font-medium leading-tight">
                        {t.name}
                        {t.comingSoon && (
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            Coming soon
                          </span>
                        )}
                        {!t.comingSoon && conn && !conn.connected && (
                          <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
                            Needs connection
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[11px] leading-snug text-muted-foreground">
                        {t.description}
                      </span>
                    </span>
                  </button>
                );
              })}
              {!available.length && (
                <p className="p-2 text-center text-xs text-muted-foreground">
                  {query ? `No integrations match “${query}”.` : "All integrations attached."}
                </p>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {value.length === 0 ? (
        <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          <strong className="mb-0.5 block text-sm font-semibold text-foreground">
            No integrations attached
          </strong>
          This agent is a plain chat agent — it can talk in channels and DMs, but has no repo
          access, tickets, or files. Add one above to give it more.
        </div>
      ) : (
        <div className="space-y-1.5">
          {value.map((entry) => {
            const type = INTEGRATION_TYPES.find((t) => t.key === entry.key);
            if (!type) return null;
            return (
              <IntegrationRow
                key={entry.key}
                type={type}
                config={entry.config}
                connections={connections}
                expanded={expandedKey === entry.key}
                onToggle={() => setExpandedKey((k) => (k === entry.key ? null : entry.key))}
                onChange={(config) =>
                  onChange(value.map((v) => (v.key === entry.key ? { ...v, config } : v)))
                }
                onRemove={() => onChange(value.filter((v) => v.key !== entry.key))}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
