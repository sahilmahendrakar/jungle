import { useEffect, useRef, useState } from "react";
import { useAuth } from "./auth";
import { checkHandle, completeOnboarding, githubConnectUrl } from "./api";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { avatarClass, initials } from "@/lib/people";
import { Check, Loader2, LogOut, X } from "lucide-react";

// lucide dropped its brand icons, so render the GitHub mark inline.
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

const STEPS = ["Your handle", "Connect GitHub"];

function Stepper({ current }: { current: number }) {
  return (
    <div className="mb-8 flex items-center gap-2">
      {STEPS.map((label, i) => (
        <div key={label} className="flex flex-1 items-center gap-2">
          <div
            className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
              i < current
                ? "bg-primary text-primary-foreground"
                : i === current
                  ? "bg-primary/15 text-primary ring-2 ring-primary"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {i < current ? <Check className="size-3.5" /> : i + 1}
          </div>
          <span
            className={`text-xs font-medium ${i === current ? "text-foreground" : "text-muted-foreground"}`}
          >
            {label}
          </span>
          {i < STEPS.length - 1 && <div className="h-px flex-1 bg-border" />}
        </div>
      ))}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { me, signOut } = useAuth();
  const profile = me?.profile;
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 left-1/2 size-[40rem] -translate-x-1/2 rounded-full bg-primary/15 blur-3xl" />
      </div>
      <div className="w-full max-w-md rounded-2xl border bg-card p-7 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-xl">
              🌴
            </div>
            <span className="font-bold">Jungle</span>
          </div>
          {profile && (
            <button
              onClick={() => signOut()}
              className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <LogOut className="size-3.5" />
              {profile.email ?? "Sign out"}
            </button>
          )}
        </div>
        {children}
      </div>
    </main>
  );
}

export function Onboarding({ onSkipGithub }: { onSkipGithub: () => void }) {
  const { me } = useAuth();
  // me is non-null here (gate guarantees it). Phase is driven by onboarding/connection state.
  if (me?.onboarded) return <ConnectGithubStep onSkip={onSkipGithub} />;
  return <HandleStep />;
}

function HandleStep() {
  const { me, refreshMe } = useAuth();
  const [handle, setHandle] = useState(me?.suggestedHandle ?? "");
  const [displayName, setDisplayName] = useState(me?.profile?.name ?? "");
  const [status, setStatus] = useState<"idle" | "checking" | "ok" | "taken" | "invalid">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);

  // Debounced availability check.
  useEffect(() => {
    const h = handle.trim();
    if (!h) return setStatus("idle");
    setStatus("checking");
    const my = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const { available, valid } = await checkHandle(h);
        if (my !== seq.current) return; // a newer keystroke won
        setStatus(!valid ? "invalid" : available ? "ok" : "taken");
      } catch {
        if (my === seq.current) setStatus("idle");
      }
    }, 350);
    return () => clearTimeout(t);
  }, [handle]);

  async function submit() {
    setError("");
    if (status !== "ok") return;
    setBusy(true);
    try {
      await completeOnboarding(handle.trim(), displayName.trim() || handle.trim());
      await refreshMe(); // now onboarded -> advances to the GitHub step
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <Stepper current={0} />
      <h1 className="text-xl font-bold tracking-tight">Pick your handle</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        This is how teammates and agents @mention you.
      </p>

      <div className="mt-5 flex items-center gap-3">
        <Avatar className="size-12 rounded-xl">
          {me?.profile?.picture && <AvatarImage src={me.profile.picture} />}
          <AvatarFallback className={`${avatarClass(handle || "you")} rounded-xl text-sm`}>
            {initials(displayName || handle || "?")}
          </AvatarFallback>
        </Avatar>
        <div className="text-sm">
          <div className="font-medium">{displayName || "Your name"}</div>
          <div className="text-muted-foreground">@{handle || "handle"}</div>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="ob-name">Display name</Label>
          <Input
            id="ob-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Ada Lovelace"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ob-handle">Handle</Label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
              @
            </span>
            <Input
              id="ob-handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
              placeholder="ada"
              className="pl-7 pr-9"
              autoFocus
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2">
              {status === "checking" && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
              {status === "ok" && <Check className="size-4 text-emerald-500" />}
              {(status === "taken" || status === "invalid") && <X className="size-4 text-destructive" />}
            </span>
          </div>
          {status === "taken" && <p className="text-xs text-destructive">That handle is taken.</p>}
          {status === "invalid" && (
            <p className="text-xs text-destructive">2–30 chars: letters, digits, - or _.</p>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button onClick={submit} disabled={busy || status !== "ok"} className="w-full" size="lg">
          {busy ? "Setting up…" : "Continue"}
        </Button>
      </div>
    </Shell>
  );
}

function ConnectGithubStep({ onSkip }: { onSkip: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function connect() {
    setError("");
    setBusy(true);
    try {
      const { url } = await githubConnectUrl();
      window.location.href = url; // full-page redirect to GitHub; callback returns to the app
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setBusy(false);
    }
  }

  return (
    <Shell>
      <Stepper current={1} />
      <div className="flex flex-col items-center text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-foreground text-background">
          <GithubMark className="size-7" />
        </div>
        <h1 className="mt-4 text-xl font-bold tracking-tight">Connect GitHub</h1>
        <p className="mt-1.5 max-w-xs text-sm text-muted-foreground">
          Let your agents read your repos and open pull requests on your behalf. You can also do
          this later from settings.
        </p>
      </div>

      {error && (
        <div className="mt-5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-6 space-y-2">
        <Button onClick={connect} disabled={busy} size="lg" className="w-full gap-2 bg-foreground text-background hover:bg-foreground/90">
          <GithubMark className="size-4" />
          {busy ? "Redirecting…" : "Connect GitHub"}
        </Button>
        <Button onClick={onSkip} variant="ghost" className="w-full">
          Skip for now
        </Button>
      </div>
    </Shell>
  );
}
