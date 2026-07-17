import { useEffect, useState } from "react";
import { Check, Loader2, MonitorSmartphone } from "lucide-react";
import { approveDeviceCode, checkDeviceCode } from "./api";
import { navigate } from "./route";
import { ViewShell } from "./components/chat/ViewShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// The /link page: where a signed-in user approves a device code shown by `jungle-agents connect`
// on one of their machines. The CLI opens this with ?code=… prefilled; the user just confirms.

export function LinkDevice({
  sidebarOpen,
  onOpenDrawer,
  onExpandSidebar,
}: {
  sidebarOpen: boolean;
  onOpenDrawer: () => void;
  onExpandSidebar: () => void;
}) {
  const initial = new URLSearchParams(location.search).get("code") ?? "";
  const [code, setCode] = useState(initial);
  const [state, setState] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [error, setError] = useState("");

  // If a code was prefilled, sanity-check it so we can warn early on an expired/used one.
  useEffect(() => {
    if (initial) checkDeviceCode(initial).catch(() => {});
  }, [initial]);

  async function approve() {
    const c = code.trim().toUpperCase();
    if (!c) return;
    setState("submitting");
    setError("");
    try {
      await approveDeviceCode(c);
      setState("done");
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setState("error");
    }
  }

  return (
    <ViewShell
      icon={<MonitorSmartphone className="size-5" />}
      title="Connect a device"
      sidebarOpen={sidebarOpen}
      onOpenDrawer={onOpenDrawer}
      onExpandSidebar={onExpandSidebar}
      testId="link-device-view"
    >
      <div className="mx-auto max-w-sm space-y-4">
        {state === "done" ? (
          <div className="rounded-xl border bg-card p-6 text-center shadow-sm">
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-500/10">
              <Check className="size-6 text-emerald-500" />
            </div>
            <h2 className="mt-3 text-base font-semibold">Device connected</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              You can return to your terminal — it's now running. Manage it any time from Environments.
            </p>
            <Button className="mt-4" onClick={() => navigate("/environments")}>
              Go to Environments
            </Button>
          </div>
        ) : (
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <h2 className="text-base font-semibold">Approve this device</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Enter the code shown by <code className="font-mono text-xs">jungle-agents connect</code> on your
              machine. Approving lets that machine run agents you assign to it.
            </p>
            <div className="mt-4 space-y-1.5">
              <Label htmlFor="device-code">Device code</Label>
              <Input
                id="device-code"
                data-testid="device-code-input"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="XXXX-XXXX"
                className="font-mono tracking-widest"
              />
            </div>
            {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
            <Button className="mt-4 w-full" onClick={approve} disabled={state === "submitting" || !code.trim()}>
              {state === "submitting" ? <Loader2 className="size-4 animate-spin" /> : "Approve device"}
            </Button>
          </div>
        )}
      </div>
    </ViewShell>
  );
}
