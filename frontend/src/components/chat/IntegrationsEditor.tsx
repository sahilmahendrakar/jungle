import { useEffect, useState } from "react";
import { AudioLines, GitBranch, HardDrive, Mail, NotebookText, Plug, Plus, SquareKanban, X } from "lucide-react";
import {
  INTEGRATION_TYPES,
  disconnectIntegration,
  getIntegrationConnection,
  integrationConnectUrl,
  type IntegrationType,
} from "../../api";
import { RepoCombobox } from "../../RepoCombobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface IntegrationDraft {
  key: string;
  config: Record<string, string>;
}

// The connected Google account of the current user (fetched by the parent). Gmail attaches to
// this account; when it's absent the gmail card tells the user to connect in Settings.
export interface GoogleConn {
  connected: boolean;
  email?: string;
}

function integrationIcon(key: string) {
  if (key === "github") return GitBranch;
  if (key === "gmail") return Mail;
  if (key === "linear") return SquareKanban;
  if (key === "notion") return NotebookText;
  if (key === "granola") return AudioLines;
  if (key === "google-drive") return HardDrive;
  return Plug;
}

// One attached integration's config fields — a name/handle + one input per configField.
// github's `repo` field gets the searchable RepoCombobox; anything else is a plain text input
// (only github is actually wired up today; the rest are catalog-only, see @jungle/shared).
function IntegrationCard({
  type,
  config,
  google,
  agentId,
  onChange,
  onRemove,
}: {
  type: IntegrationType;
  config: Record<string, string>;
  google?: GoogleConn;
  // The agent being edited, if it already exists (settings panel). Absent in the create dialog —
  // connection-based integrations can only be OAuth-connected after the agent is saved.
  agentId?: string;
  onChange: (config: Record<string, string>) => void;
  onRemove: () => void;
}) {
  const Icon = integrationIcon(type.key);
  return (
    <div className="space-y-2.5 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-foreground" />
        <span className="text-sm font-semibold">{type.name}</span>
        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
          attached
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-6 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label={`Remove ${type.name}`}
        >
          <X className="size-3.5" />
        </Button>
      </div>
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
      {type.key === "gmail" && <GmailCardBody config={config} google={google} onChange={onChange} />}
      {type.connection === "oauth" && (
        <ConnectionCardBody type={type} config={config} agentId={agentId} onChange={onChange} />
      )}
    </div>
  );
}

// Generic card body for connection-based (per-agent OAuth) integrations — Linear, Notion, Granola,
// Google Drive. Shows a Connect button / connected status + a write-approval toggle. The OAuth
// grant is per-agent, so connecting requires the agent to exist: in the create dialog (no agentId)
// we tell the user to save first and connect from the profile.
function ConnectionCardBody({
  type,
  config,
  agentId,
  onChange,
}: {
  type: IntegrationType;
  config: Record<string, string>;
  agentId?: string;
  onChange: (config: Record<string, string>) => void;
}) {
  const requireApproval = String(config.requireApproval ?? "true") !== "false";
  const [status, setStatus] = useState<{ connected: boolean; externalAccount?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!agentId) return;
    let live = true;
    getIntegrationConnection(agentId, type.key)
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus({ connected: false }));
    return () => {
      live = false;
    };
  }, [agentId, type.key]);

  const approvalToggle = (
    <label className="flex items-center gap-2 text-xs text-foreground">
      <input
        type="checkbox"
        className="size-3.5 accent-primary"
        data-testid={`${type.key}-require-approval`}
        checked={requireApproval}
        onChange={(e) => onChange({ ...config, requireApproval: e.target.checked ? "true" : "false" })}
      />
      Require my approval before this agent makes changes in {type.name}
    </label>
  );

  if (!agentId) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-amber-600">
          Save this agent, then connect {type.name} from its profile.
        </p>
        {approvalToggle}
      </div>
    );
  }

  async function connect() {
    setBusy(true);
    try {
      const { url } = await integrationConnectUrl(agentId!, type.key);
      window.location.href = url; // full-page redirect to the provider consent screen
    } catch {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    try {
      await disconnectIntegration(agentId!, type.key);
      setStatus({ connected: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {status?.connected ? (
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground">
            Connected{status.externalAccount ? <> · <span className="font-medium text-foreground">{status.externalAccount}</span></> : null}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 text-xs text-muted-foreground hover:text-destructive"
            disabled={busy}
            onClick={disconnect}
            data-testid={`${type.key}-disconnect`}
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          className="h-7 text-xs"
          disabled={busy}
          onClick={connect}
          data-testid={`${type.key}-connect`}
        >
          Connect {type.name}
        </Button>
      )}
      {approvalToggle}
    </div>
  );
}

// Gmail is connection-based (no text config): show the connected account + a send-approval toggle,
// or a prompt to connect in Settings if the current user hasn't linked a Google account yet.
function GmailCardBody({
  config,
  google,
  onChange,
}: {
  config: Record<string, string>;
  google?: GoogleConn;
  onChange: (config: Record<string, string>) => void;
}) {
  // Approval defaults on; the value is a string in local drafts and may be a boolean when loaded
  // from the server — treat anything but an explicit false/"false" as on.
  const requireApproval = String(config.requireSendApproval ?? "true") !== "false";
  if (!google?.connected) {
    return (
      <p className="text-xs text-amber-600">
        Not connected. Connect a Google account in <span className="font-medium">Settings → Google</span>{" "}
        to use this integration.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Using <span className="font-medium text-foreground">{google.email}</span>
      </p>
      <label className="flex items-center gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          className="size-3.5 accent-primary"
          data-testid="gmail-require-approval"
          checked={requireApproval}
          onChange={(e) =>
            onChange({ ...config, requireSendApproval: e.target.checked ? "true" : "false" })
          }
        />
        Require my approval before sending or modifying email
      </label>
    </div>
  );
}

// Attach/configure/remove an agent's integrations — used by both the create-agent dialog and
// the agent settings panel. An agent with no integrations is just a blank chat agent.
export function IntegrationsEditor({
  value,
  onChange,
  google,
  agentId,
}: {
  value: IntegrationDraft[];
  onChange: (v: IntegrationDraft[]) => void;
  // The current user's Google connection, so the gmail card can show status / the approval toggle.
  google?: GoogleConn;
  // The agent being edited, if it already exists (settings panel). Enables per-agent OAuth connect
  // for connection-based integrations; absent in the create dialog.
  agentId?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const attachedKeys = new Set(value.map((v) => v.key));
  const available = INTEGRATION_TYPES.filter((t) => !attachedKeys.has(t.key));

  function add(type: IntegrationType) {
    if (type.comingSoon) return;
    onChange([...value, { key: type.key, config: {} }]);
    setPickerOpen(false);
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <Label>Integrations</Label>
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button variant="secondary" size="sm" className="h-7 gap-1 text-xs" data-testid="add-integration">
              <Plus className="size-3.5" /> Add integration
            </Button>
          </PopoverTrigger>
          <PopoverContent portal={false} align="end" className="w-80 space-y-1 p-2">
            {available.map((t) => {
              const Icon = integrationIcon(t.key);
              return (
                <button
                  key={t.key}
                  type="button"
                  disabled={t.comingSoon}
                  onClick={() => add(t)}
                  data-testid={`integration-option-${t.key}`}
                  className="flex w-full items-start gap-2.5 rounded-md p-2 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  <Icon className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      {t.name}
                      {t.comingSoon && (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Coming soon
                        </span>
                      )}
                    </span>
                    <span className="block text-xs leading-snug text-muted-foreground">
                      {t.description}
                    </span>
                  </span>
                </button>
              );
            })}
            {!available.length && (
              <p className="p-2 text-xs text-muted-foreground">All integrations attached.</p>
            )}
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
        <div className="space-y-2.5">
          {value.map((entry) => {
            const type = INTEGRATION_TYPES.find((t) => t.key === entry.key);
            if (!type) return null;
            return (
              <IntegrationCard
                key={entry.key}
                type={type}
                config={entry.config}
                google={google}
                agentId={agentId}
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
