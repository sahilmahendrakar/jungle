import { useEffect, useState } from "react";
import { Check, Copy, Loader2, MonitorSmartphone, Plus, Trash2, Wifi, WifiOff } from "lucide-react";
import { listDevices, updateDevice, removeDevice, type RunnerHost } from "./api";
import { supportsUnsandboxed } from "@jungle/shared";
import { fmtRelative } from "./lib/chat";
import { ViewShell } from "./components/chat/ViewShell";
import { SelectMenu } from "./components/chat/panels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// The Environments (Devices) page: the account's registered machines that can run agents. A
// machine appears here after `jungle-agents connect`; from then on it's a selectable environment
// in the New Agent dialog. Account-scoped (shown across all the user's workspaces).

const CONNECT_CMD = "npx jungle-agents connect";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

const ASSIGN_OPTIONS = [
  { id: "owner_only", label: "Only me" },
  { id: "workspace_members", label: "Anyone in this workspace" },
];

// Whether agents on this device run in an isolated per-agent workspace (sandboxed) or directly in
// the directory `jungle-agents connect` was run from (unsandboxed — the agent edits your real
// project files in place). The trigger shows the short label; the hint spells out the effect in
// the dropdown so the card stays compact.
const SANDBOX_OPTIONS = [
  { id: "true", label: "Sandboxed", hint: "Isolated per-agent workspace" },
  { id: "false", label: "Not sandboxed", hint: "Runs in the connect directory" },
];

function DeviceCard({
  device,
  workspaceId,
  onChanged,
}: {
  device: RunnerHost;
  workspaceId: string | null;
  onChanged: () => void;
}) {
  const [name, setName] = useState(device.name);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function saveName() {
    setEditing(false);
    if (name.trim() && name.trim() !== device.name) {
      await updateDevice(device.id, { name: name.trim() }).then(onChanged).catch(() => setName(device.name));
    } else {
      setName(device.name);
    }
  }

  async function setPolicy(policy: string) {
    setBusy(true);
    // "workspace_members" shares the device into the workspace being viewed; "owner_only" locks it
    // back down. Sharing into multiple workspaces at once is a later refinement.
    const sharedWorkspaceIds = policy === "workspace_members" && workspaceId ? [workspaceId] : [];
    await updateDevice(device.id, { assignPolicy: policy, sharedWorkspaceIds })
      .then(onChanged)
      .finally(() => setBusy(false));
  }

  async function setSandboxed(sandboxed: boolean) {
    setBusy(true);
    await updateDevice(device.id, { sandboxed }).then(onChanged).finally(() => setBusy(false));
  }

  async function remove() {
    if (!confirm(`Remove "${device.name}"? Agents running on it will go offline until reassigned.`)) return;
    setBusy(true);
    await removeDevice(device.id).then(onChanged).finally(() => setBusy(false));
  }

  const meta = [
    device.hostname,
    device.platform && device.arch ? `${device.platform}/${device.arch}` : device.platform,
    device.last_seen_at ? `seen ${fmtRelative(device.last_seen_at)}` : null,
    device.running_agents > 0
      ? `${device.running_agents} agent${device.running_agents === 1 ? "" : "s"} running`
      : null,
  ].filter(Boolean);

  // A device whose reported CLI version is known to be too old to honor `sandboxed` can't run
  // unsandboxed, so don't offer that option (the backend would reject it anyway). An unknown
  // version (never connected) is allowed through; the provisioner downgrades at run time if it
  // turns out old, and the note below surfaces that.
  const cliTooOld = device.runner_version !== null && !supportsUnsandboxed(device.runner_version);
  const sandboxOptions = cliTooOld ? SANDBOX_OPTIONS.filter((o) => o.id === "true") : SANDBOX_OPTIONS;

  return (
    <div data-testid="device-card" className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <MonitorSmartphone className="size-4 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {editing ? (
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => e.key === "Enter" && saveName()}
                className="h-7 max-w-56 text-sm font-semibold"
              />
            ) : (
              <button className="truncate text-sm font-semibold hover:underline" onClick={() => setEditing(true)}>
                {device.name}
              </button>
            )}
            <span
              className={
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium " +
                (device.online ? "bg-emerald-500/10 text-emerald-600" : "bg-slate-500/10 text-muted-foreground")
              }
            >
              {device.online ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
              {device.online ? "Online" : "Offline"}
            </span>
            {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          </div>
          {meta.length > 0 && (
            <div className="mt-1 truncate text-xs text-muted-foreground">{meta.join(" · ")}</div>
          )}
          <div className="mt-3 grid gap-3 border-t pt-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Access</Label>
              <SelectMenu
                value={device.assign_policy}
                onChange={setPolicy}
                options={ASSIGN_OPTIONS}
                testId="device-access"
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Sandboxing</Label>
              <SelectMenu
                value={String(device.sandboxed)}
                onChange={(v) => setSandboxed(v === "true")}
                options={sandboxOptions}
                testId="device-sandboxed"
                disabled={busy}
              />
            </div>
          </div>
        </div>
        <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground" onClick={remove} disabled={busy}>
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export function Environments({
  workspaceId,
  sidebarOpen,
  onOpenDrawer,
  onExpandSidebar,
}: {
  workspaceId: string | null;
  sidebarOpen: boolean;
  onOpenDrawer: () => void;
  onExpandSidebar: () => void;
}) {
  const [devices, setDevices] = useState<RunnerHost[] | null>(null);

  function reload() {
    listDevices().then(setDevices).catch(() => setDevices([]));
  }
  useEffect(reload, []);

  // Live online/offline: the backend fans out device_status to the owner; useChatSocket rebroadcasts
  // it as a window event so this page (outside the chat store) can flip the dot without a refetch.
  useEffect(() => {
    const onStatus = (e: Event) => {
      const { deviceId, online } = (e as CustomEvent).detail as { deviceId: string; online: boolean };
      setDevices((ds) => (ds ? ds.map((d) => (d.id === deviceId ? { ...d, online } : d)) : ds));
    };
    window.addEventListener("jungle:device_status", onStatus);
    return () => window.removeEventListener("jungle:device_status", onStatus);
  }, []);

  return (
    <ViewShell
      icon={<MonitorSmartphone className="size-5" />}
      title="Environments"
      sidebarOpen={sidebarOpen}
      onOpenDrawer={onOpenDrawer}
      onExpandSidebar={onExpandSidebar}
      testId="environments-view"
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Plus className="size-4 text-primary" /> Connect a device
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Run this on any machine you own (laptop, desktop, server) to let agents run there. You'll
            approve it here in the browser — no API keys or config needed.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 truncate rounded-md bg-background px-3 py-2 font-mono text-xs">{CONNECT_CMD}</code>
            <CopyButton text={CONNECT_CMD} />
          </div>
        </div>

        {devices === null ? (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : devices.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No devices yet. Run the command above on a machine to add your first one.
          </p>
        ) : (
          <div className="space-y-3">
            {devices.map((d) => (
              <DeviceCard key={d.id} device={d} workspaceId={workspaceId} onChanged={reload} />
            ))}
          </div>
        )}
      </div>
    </ViewShell>
  );
}
