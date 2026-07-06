import { useState } from "react";
import { useAuth } from "./auth";
import { Button } from "@/components/ui/button";
import { Bot, GitPullRequest, Zap } from "lucide-react";

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-5" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

const FEATURES = [
  { icon: Bot, title: "Agents as teammates", desc: "DM them or @mention them in any channel." },
  { icon: GitPullRequest, title: "They ship real work", desc: "Connect a repo and they open PRs for you." },
  { icon: Zap, title: "Live everywhere", desc: "Replies stream to all your devices instantly." },
];

export function GoogleSignIn() {
  const { signIn } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function go() {
    setError("");
    setBusy(true);
    try {
      await signIn();
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      // Don't shout about the user simply closing the Google popup.
      if (!/popup-closed|cancelled-popup|popup_closed/i.test(msg)) setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative grid min-h-screen grid-cols-1 overflow-hidden lg:grid-cols-2">
      {/* Left: brand / pitch */}
      <div className="relative hidden flex-col justify-between bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 -left-24 size-[34rem] rounded-full bg-primary/30 blur-3xl" />
          <div className="absolute bottom-0 right-0 size-[28rem] rounded-full bg-teal-400/20 blur-3xl" />
        </div>
        <div className="relative flex items-center gap-2.5">
          <img src="/icon-192.png" alt="Jungle" className="size-9 rounded-xl" />
          <span className="text-lg font-bold">Jungle</span>
        </div>
        <div className="relative space-y-8">
          <h1 className="max-w-md text-4xl font-bold leading-tight tracking-tight">
            Where your team and its agents work side by side.
          </h1>
          <div className="space-y-5">
            {FEATURES.map((f) => (
              <div key={f.title} className="flex items-start gap-3">
                <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/10">
                  <f.icon className="size-5 text-white" />
                </div>
                <div>
                  <div className="font-semibold">{f.title}</div>
                  <div className="text-sm text-sidebar-foreground/65">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="relative text-xs text-sidebar-foreground/45">
          Built on the Claude Agent SDK.
        </div>
      </div>

      {/* Right: sign-in */}
      <div className="flex items-center justify-center bg-background px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <img src="/icon-192.png" alt="Jungle" className="size-9 rounded-xl" />
            <span className="text-lg font-bold">Jungle</span>
          </div>

          <h2 className="text-2xl font-bold tracking-tight">Welcome</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Sign in to start working with your agents.
          </p>

          {error && (
            <div className="mt-5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <Button
            onClick={go}
            disabled={busy}
            variant="outline"
            size="lg"
            className="mt-6 w-full gap-3 text-base font-medium"
            data-testid="google-signin"
          >
            <GoogleMark />
            {busy ? "Opening Google…" : "Continue with Google"}
          </Button>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            By continuing you agree to let Jungle act on your behalf for the agents you create.
          </p>
        </div>
      </div>
    </main>
  );
}
