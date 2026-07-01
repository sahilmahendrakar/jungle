import { useEffect, useState } from "react";
import { githubInstallUrl, listGithubRepos, type Repo } from "./api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Check, ChevronsUpDown, GitBranch, Loader2, Lock, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Send the user to GitHub to install the App / grant access to specific repos. Full-page
// redirect (same pattern as Connect); the callback returns to the app, which re-lists repos.
async function configureRepoAccess() {
  try {
    const { url } = await githubInstallUrl();
    window.location.href = url;
  } catch {
    // Best-effort affordance — the picker still works for already-granted repos.
  }
}

// Searchable repo picker populated from the user's connected GitHub account. Falls back to a
// plain text input when GitHub isn't connected (or auth is off, e.g. dev mode).
export function RepoCombobox({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"loading" | "ready" | "manual">("loading");
  const [repos, setRepos] = useState<Repo[]>([]);

  useEffect(() => {
    let cancelled = false;
    listGithubRepos()
      .then((r) => {
        if (cancelled) return;
        if (r.connected && r.repos) {
          setRepos(r.repos);
          setPhase("ready");
        } else {
          setPhase("manual");
        }
      })
      .catch(() => !cancelled && setPhase("manual"));
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === "manual") {
    return (
      <div className="space-y-1">
        <Input
          data-testid="agent-repo"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="owner/name"
        />
        <p className="text-xs text-muted-foreground">
          Connect GitHub to pick from your repositories.
        </p>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          data-testid="agent-repo"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <GitBranch className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {value || <span className="text-muted-foreground">Select a repository…</span>}
            </span>
          </span>
          {phase === "loading" ? (
            <Loader2 className="size-4 shrink-0 animate-spin opacity-50" />
          ) : (
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        portal={false}
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <Command>
          <CommandInput placeholder="Search repositories…" />
          <CommandList>
            {phase === "loading" ? (
              <div className="py-6 text-center">
                <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                <CommandEmpty>No repositories found.</CommandEmpty>
                {repos.map((r) => (
                  <CommandItem
                    key={r.full_name}
                    value={r.full_name}
                    onSelect={() => {
                      onChange(r.full_name);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn("size-4", value === r.full_name ? "opacity-100" : "opacity-0")}
                    />
                    <span className="truncate">{r.full_name}</span>
                    {r.private && <Lock className="ml-auto size-3 shrink-0 text-muted-foreground" />}
                  </CommandItem>
                ))}
              </>
            )}
          </CommandList>
        </Command>
        {/* Missing a repo (e.g. your own private ones)? The picker only lists repos the GitHub
            App is installed on — send the user to GitHub to grant access to more. */}
        {phase === "ready" && (
          <div className="border-t p-1">
            <button
              type="button"
              onClick={() => void configureRepoAccess()}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <Settings2 className="size-3.5 shrink-0" />
              Missing a repo? Configure GitHub access…
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
