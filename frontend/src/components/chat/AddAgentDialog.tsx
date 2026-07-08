import { useEffect, useState } from "react";
import { Bot, Cloud, MonitorSmartphone } from "lucide-react";
import { createParticipant, listDevices, type RunnerHost } from "../../api";
import { MODEL_OPTIONS, SDK_MODE_OPTIONS } from "../../lib/chat";
import { SelectMenu } from "./panels";
import { IntegrationsEditor, validateIntegrations, type IntegrationDraft } from "./IntegrationsEditor";
import { useConnections } from "@/lib/connections";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// The create-agent dialog: a persistent cloud agent (kind "agent", sdk runtime). Owns its own
// form state; tells the parent to refresh People on success, and to surface any notice.
export function AddAgentDialog({
  open,
  onOpenChange,
  onCreated,
  onNotice,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
  onNotice: (msg: string) => void;
}) {
  const [agHandle, setAgHandle] = useState("");
  const [agName, setAgName] = useState("");
  const [integrations, setIntegrations] = useState<IntegrationDraft[]>([]);
  const [agModel, setAgModel] = useState(MODEL_OPTIONS[0].id);
  const [agMode, setAgMode] = useState(SDK_MODE_OPTIONS[0].id); // new agents are sdk runtime
  const [addingAgent, setAddingAgent] = useState(false);
  // Environment: "cloud" (default) or `self:<hostId>` for one of the account's registered devices.
  const [env, setEnv] = useState("cloud");
  const [devices, setDevices] = useState<RunnerHost[]>([]);
  // The creator's per-user connections gate the integration rows; missing ones can be linked
  // inline (popup OAuth) without losing this dialog's draft.
  const connections = useConnections(open);

  useEffect(() => {
    if (!open) return;
    listDevices().then(setDevices).catch(() => setDevices([]));
  }, [open]);

  const envOptions = [
    { id: "cloud", label: "☁️  Cloud sandbox (recommended)" },
    ...devices.map((d) => ({
      id: `self:${d.id}`,
      label: `💻  ${d.name}${d.online ? "" : " — offline"}`,
    })),
  ];
  const selectedDevice = env.startsWith("self:") ? devices.find((d) => `self:${d.id}` === env) : null;

  async function submitAddAgent() {
    if (!agHandle.trim() || !agName.trim()) {
      onNotice("Agent handle and name are required.");
      return;
    }
    // Every attached integration must be complete (connection linked, repo picked) — surfaced
    // here instead of silently dropping half-configured ones at create time.
    const problem = validateIntegrations(integrations, connections);
    if (problem) {
      onNotice(problem);
      return;
    }
    setAddingAgent(true);
    try {
      const selfHost = env.startsWith("self:") ? env.slice(5) : null;
      await createParticipant({
        kind: "agent",
        handle: agHandle.trim(),
        displayName: agName.trim(),
        integrations,
        model: agModel,
        mode: agMode,
        ...(selfHost ? { runnerProvider: "self_hosted", hostId: selfHost } : {}),
      });
      onOpenChange(false);
      setAgHandle("");
      setAgName("");
      setIntegrations([]);
      setAgModel(MODEL_OPTIONS[0].id);
      setAgMode(SDK_MODE_OPTIONS[0].id);
      setEnv("cloud");
      onCreated();
    } catch (e) {
      onNotice(String((e as Error).message ?? e));
    } finally {
      setAddingAgent(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-5 text-primary" /> Add an agent
          </DialogTitle>
          <DialogDescription>
            A persistent, cloud-living assistant. Agents can just chat, or be given
            integrations for extra tools &amp; context.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="agent-handle">Handle</Label>
            <Input
              id="agent-handle"
              data-testid="agent-handle"
              value={agHandle}
              onChange={(e) => setAgHandle(e.target.value)}
              placeholder="e.g. deploy-bot"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-name">Display name</Label>
            <Input
              id="agent-name"
              data-testid="agent-name"
              value={agName}
              onChange={(e) => setAgName(e.target.value)}
              placeholder="e.g. Deploy Bot"
            />
          </div>
          <IntegrationsEditor value={integrations} onChange={setIntegrations} connections={connections} />
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              {selectedDevice ? <MonitorSmartphone className="size-3.5" /> : <Cloud className="size-3.5" />}
              Environment
            </Label>
            <SelectMenu value={env} onChange={setEnv} options={envOptions} testId="agent-environment" />
            {selectedDevice ? (
              <p className="text-xs text-muted-foreground">
                Runs on <span className="font-medium">{selectedDevice.name}</span> with that machine's
                access. Anyone in this workspace can message it, and tool approvals apply — review the
                permission mode below.
                {!selectedDevice.online && " This device is offline; the agent will start when it reconnects."}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Runs in a managed cloud sandbox. To run an agent on your own machine, connect a device
                from the Environments page first.
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Model</Label>
              <SelectMenu
                value={agModel}
                onChange={setAgModel}
                options={MODEL_OPTIONS}
                testId="agent-model"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Tool permissions</Label>
              <SelectMenu
                value={agMode}
                onChange={setAgMode}
                options={SDK_MODE_OPTIONS}
                testId="agent-mode"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button data-testid="add-agent-button" onClick={submitAddAgent} disabled={addingAgent}>
            {addingAgent ? "Adding…" : "Add agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
