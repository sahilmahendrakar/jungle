import { useState } from "react";
import { Bot, GitBranch } from "lucide-react";
import { createParticipant } from "../../api";
import { MODEL_OPTIONS, SDK_MODE_OPTIONS } from "../../lib/chat";
import { SelectMenu } from "./panels";
import { RepoCombobox } from "../../RepoCombobox";
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
  const [agRepo, setAgRepo] = useState("");
  const [agModel, setAgModel] = useState(MODEL_OPTIONS[0].id);
  const [agMode, setAgMode] = useState(SDK_MODE_OPTIONS[0].id); // new agents are sdk runtime
  const [addingAgent, setAddingAgent] = useState(false);

  async function submitAddAgent() {
    if (!agHandle.trim() || !agName.trim()) {
      onNotice("Agent handle and name are required.");
      return;
    }
    setAddingAgent(true);
    try {
      await createParticipant({
        kind: "agent",
        handle: agHandle.trim(),
        displayName: agName.trim(),
        repo: agRepo.trim() || undefined,
        model: agModel,
        mode: agMode,
      });
      onOpenChange(false);
      setAgHandle("");
      setAgName("");
      setAgRepo("");
      setAgModel(MODEL_OPTIONS[0].id);
      setAgMode(SDK_MODE_OPTIONS[0].id);
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
            A persistent, cloud-living assistant. Give it a repo and it can open
            real PRs.
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
          <div className="space-y-1.5">
            <Label>
              <GitBranch className="size-3.5" /> Repository{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <RepoCombobox value={agRepo} onChange={setAgRepo} />
            {agRepo.trim() && (
              <p className="text-xs text-muted-foreground">
                With a repo this takes ~30s (clones it).
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
