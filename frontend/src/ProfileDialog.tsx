import { useState } from "react";
import { githubConnectUrl, disconnectGithub, type Participant } from "./api";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { avatarClass, initials } from "@/lib/people";
import { cn } from "@/lib/utils";
import { Check, LogOut, Mail, Unlink } from "lucide-react";

// lucide dropped its brand icons, so render the GitHub mark inline.
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function ProfileDialog({
  open,
  onOpenChange,
  me,
  email,
  picture,
  github,
  onSignOut,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  me: Participant;
  email?: string | null;
  picture?: string | null;
  github?: { connected: boolean; login?: string };
  onSignOut: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Track connection locally so a disconnect updates the UI without a reload.
  const [connected, setConnected] = useState(!!github?.connected);
  const [login, setLogin] = useState(github?.login);

  async function connectGithub() {
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

  async function unlinkGithub() {
    setError("");
    setBusy(true);
    try {
      await disconnectGithub();
      setConnected(false);
      setLogin(undefined);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="profile-dialog">
        <DialogHeader>
          <DialogTitle>Your profile</DialogTitle>
          <DialogDescription>Manage your account and connections.</DialogDescription>
        </DialogHeader>

        {/* Identity */}
        <div className="flex items-center gap-3">
          <Avatar className="size-14 rounded-xl">
            {picture && <AvatarImage src={picture} alt={me.display_name} />}
            <AvatarFallback className={cn(avatarClass(me.handle), "rounded-xl text-base")}>
              {initials(me.display_name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{me.display_name}</div>
            <div className="truncate text-sm text-muted-foreground">@{me.handle}</div>
            {email && (
              <div className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                <Mail className="size-3 shrink-0" />
                {email}
              </div>
            )}
          </div>
        </div>

        {/* GitHub connection */}
        <div className="rounded-lg border bg-muted/30 p-3">
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
              <GithubMark className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">GitHub</div>
              {connected ? (
                <div className="flex items-center gap-1 text-xs text-emerald-600">
                  <Check className="size-3 shrink-0" />
                  <span className="truncate">Connected{login ? ` as @${login}` : ""}</span>
                </div>
              ) : (
                <div className="truncate text-xs text-muted-foreground">
                  Let your agents read repos and open pull requests.
                </div>
              )}
            </div>
            {connected ? (
              <Button
                data-testid="profile-disconnect-github"
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
                data-testid="profile-connect-github"
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
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>

        {/* Sign out */}
        <Button
          data-testid="profile-sign-out"
          onClick={onSignOut}
          variant="ghost"
          className="w-full justify-start gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <LogOut className="size-4" />
          Sign out
        </Button>
      </DialogContent>
    </Dialog>
  );
}
