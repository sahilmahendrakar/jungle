import { useState } from "react";
import { GitBranch, Plug, Plus, X } from "lucide-react";
import { INTEGRATION_TYPES, type IntegrationType } from "../../api";
import { RepoCombobox } from "../../RepoCombobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface IntegrationDraft {
  key: string;
  config: Record<string, string>;
}

function integrationIcon(key: string) {
  return key === "github" ? GitBranch : Plug;
}

// One attached integration's config fields — a name/handle + one input per configField.
// github's `repo` field gets the searchable RepoCombobox; anything else is a plain text input
// (only github is actually wired up today; the rest are catalog-only, see @jungle/shared).
function IntegrationCard({
  type,
  config,
  onChange,
  onRemove,
}: {
  type: IntegrationType;
  config: Record<string, string>;
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
    </div>
  );
}

// Attach/configure/remove an agent's integrations — used by both the create-agent dialog and
// the agent settings panel. An agent with no integrations is just a blank chat agent.
export function IntegrationsEditor({
  value,
  onChange,
}: {
  value: IntegrationDraft[];
  onChange: (v: IntegrationDraft[]) => void;
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
