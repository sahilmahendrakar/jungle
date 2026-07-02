import { useEffect, useState } from "react";
import { useAuth } from "./auth";
import {
  disconnectGithub,
  getGithubStatus,
  githubConnectUrl,
  type GithubStatus,
} from "./api";
import { navigate } from "./route";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { avatarClass, initials } from "@/lib/people";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  Loader2,
  LogOut,
  Mail,
  Unlink,
} from "lucide-react";

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function Settings() {
  const { me, refreshMe, signOut } = useAuth();
  const participant = me?.participant;
  const profile = me?.profile;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ghStatus, setGhStatus] = useState<GithubStatus | null>(null);
  const [ghLoading, setGhLoading] = useState(true);

  const connected = ghStatus?.connected ?? !!me?.github?.connected;
  const login = ghStatus?.login ?? me?.github?.login;

  useEffect(() => {
    let cancelled = false;
    setGhLoading(true);
    getGithubStatus()
      .then((s) => {
        if (!cancelled) setGhStatus(s);
      })
      .catch(() => {
        if (!cancelled) setGhStatus(null);
      })
      .finally(() => {
        if (!cancelled) setGhLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [me?.github?.connected, me?.github?.login]);

  async function connectGithub() {
    setError("");
    setBusy(true);
    try {
      const { url } = await githubConnectUrl();
      window.location.href = url;
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setBusy(false);
    }
  }

  async function unlinkGithub() {
    setError("");
    setBusy(true);
    try {
      await disconnectGithub();
      await refreshMe();
      setGhStatus((s) =>
        s ? { ...s, connected: false, login: undefined, installationCount: 0, repoCount: 0 } : s,
      );
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (!participant) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const needsAppInstall = connected && ghStatus && ghStatus.repoCount === 0;

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

      <div className="mx-auto w-full max-w-lg px-4 py-6">
        {/* Account */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Account
          </h2>
          <div className="flex items-center gap-3 rounded-xl border bg-card p-4">
            <Avatar className="size-14 rounded-xl">
              {profile?.picture && <AvatarImage src={profile.picture} alt={participant.display_name} />}
              <AvatarFallback
                className={cn(avatarClass(participant.handle), "rounded-xl text-base")}
              >
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

        {/* GitHub OAuth */}
        <section className="mt-8 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            GitHub
          </h2>
          <div className="rounded-xl border bg-card p-4">
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
                <GithubMark className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Connect account</div>
                {connected ? (
                  <div className="flex items-center gap-1 text-xs text-emerald-600">
                    <Check className="size-3 shrink-0" />
                    <span className="truncate">Connected{login ? ` as @${login}` : ""}</span>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    Link your GitHub identity so Jungle can see your installations.
                  </div>
                )}
              </div>
              {connected ? (
                <Button
                  data-testid="settings-disconnect-github"
                  onClick={unlinkGithub}
                  disabled={busy}
                  size="icon"
                  variant="ghost"
                  title="Disconnect GitHub"
                  aria-label="Disconnect GitHub"
                  className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <Unlink className="size-4" />
                </Button>
              ) : (
                <Button
                  data-testid="settings-connect-github"
                  onClick={connectGithub}
                  disabled={busy}
                  size="sm"
                  className="shrink-0 gap-1.5 bg-foreground text-background hover:bg-foreground/90"
                >
                  <GithubMark className="size-3.5" />
                  {busy ? "Redirecting…" : "Connect"}
                </Button>
              )}
            </div>
          </div>
        </section>

        {/* GitHub App installation — required for agent repo picker */}
        <section className="mt-8 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            GitHub App
          </h2>
          <div className="rounded-xl border bg-card p-4" data-testid="settings-github-app">
            {!connected ? (
              <p className="text-sm text-muted-foreground">
                Connect GitHub above first, then install the Jungle GitHub App to grant access to
                your repositories.
              </p>
            ) : ghLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Checking installations…
              </div>
            ) : needsAppInstall ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Your agents can only work on repositories where the{" "}
                  <span className="font-medium text-foreground">Jungle GitHub App</span> is installed.
                  {ghStatus!.installationCount > 0
                    ? " You have an installation, but no repositories are granted yet."
                    : " Install the app on your personal account or organization to add repos."}
                </p>
                {ghStatus?.installUrl && (
                  <Button asChild className="gap-2">
                    <a
                      href={ghStatus.installUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="settings-install-github-app"
                    >
                      <GithubMark className="size-4" />
                      Install GitHub App
                      <ExternalLink className="size-3.5 opacity-60" />
                    </a>
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-1 text-sm text-emerald-600">
                  <Check className="size-4 shrink-0" />
                  {ghStatus!.repoCount} repositor{ghStatus!.repoCount === 1 ? "y" : "ies"} available
                  for agents
                </div>
                <p className="text-xs text-muted-foreground">
                  {ghStatus!.installationCount} app installation
                  {ghStatus!.installationCount === 1 ? "" : "s"} on your account.
                </p>
                {ghStatus?.installUrl && (
                  <Button variant="outline" size="sm" asChild className="gap-2">
                    <a
                      href={ghStatus.installUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="settings-manage-github-app"
                    >
                      Manage app access
                      <ExternalLink className="size-3 opacity-60" />
                    </a>
                  </Button>
                )}
              </div>
            )}
          </div>
        </section>

        {error && (
          <p className="mt-4 text-sm text-destructive" data-testid="settings-error">
            {error}
          </p>
        )}

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
    </main>
  );
}
