import { useEffect, useState } from "react";
import { listParticipants, createParticipant, type Participant } from "./api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { avatarClass, initials } from "@/lib/people";
import { Bot, ChevronDown, GitBranch, Plus, User } from "lucide-react";

// Dev sign-in: no real auth. Pick an existing participant (sets ?as=<id>) or create one.
function signInAs(id: string) {
  window.location.search = `?as=${id}`; // reloads; App reads ?as
}

export function SignIn() {
  const [people, setPeople] = useState<Participant[]>([]);
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [kind, setKind] = useState<"human" | "agent">("human");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const refresh = () =>
    listParticipants()
      .then((rows) => {
        setPeople(rows);
        setError("");
      })
      .catch((e) => setError(String((e as Error).message ?? e)));
  useEffect(() => {
    refresh();
  }, []);

  async function create() {
    setError("");
    if (!handle.trim() || !displayName.trim()) {
      setError("handle and display name are required");
      return;
    }
    setBusy(true);
    try {
      const p = await createParticipant({
        kind,
        handle: handle.trim(),
        displayName: displayName.trim(),
        integrations:
          kind === "agent" && repo.trim()
            ? [{ key: "github", config: { repo: repo.trim() } }]
            : undefined,
      });
      if (kind === "human") {
        signInAs(p.id); // creating a human signs you straight in
      } else {
        setHandle("");
        setDisplayName("");
        setRepo("");
        await refresh(); // agent now appears in the list
      }
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      data-testid="signin"
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4"
    >
      {/* Ambient gradient backdrop */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 left-1/2 size-[40rem] -translate-x-1/2 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute -bottom-40 -right-20 size-[32rem] rounded-full bg-fuchsia-400/15 blur-3xl" />
      </div>

      <div className="w-full max-w-md rounded-2xl border bg-card/80 p-7 shadow-2xl backdrop-blur-xl">
        <div className="mb-6 flex items-center gap-3">
          <img src="/icon-192.png" alt="Jungle" className="size-11 rounded-xl shadow-sm" />
          <div>
            <h1 className="text-xl font-bold tracking-tight">Jungle</h1>
            <p className="text-sm text-muted-foreground">
              Chat with agents that do real work.
            </p>
          </div>
        </div>

        {error && (
          <div
            data-testid="signin-error"
            className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Choose who you are
        </div>
        <div className="mb-5 max-h-72 space-y-1.5 overflow-y-auto">
          {people.length === 0 && (
            <div className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              No participants yet — create one below.
            </div>
          )}
          {people.map((p) => (
            <button
              key={p.id}
              data-testid="participant-item"
              onClick={() => signInAs(p.id)}
              className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-accent"
            >
              <Avatar>
                <AvatarFallback className={avatarClass(p.handle)}>
                  {initials(p.display_name || p.handle)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 truncate font-medium">
                  @{p.handle}
                  {p.kind === "agent" && (
                    <Bot className="size-3.5 text-primary" />
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {p.display_name}
                  {p.repo ? ` · ${p.repo}` : ""}
                </div>
              </div>
            </button>
          ))}
        </div>

        <button
          data-testid="create-toggle"
          onClick={() => setShowCreate((v) => !v)}
          className="flex w-full items-center justify-between rounded-lg px-1 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="flex items-center gap-2">
            <Plus className="size-4" /> Create a participant
          </span>
          <ChevronDown
            className={`size-4 transition-transform ${showCreate ? "rotate-180" : ""}`}
          />
        </button>

        {showCreate && (
          <div className="mt-2 space-y-3 rounded-xl border bg-muted/30 p-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-kind">Type</Label>
              <div className="relative">
                <select
                  id="new-kind"
                  data-testid="new-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as "human" | "agent")}
                  className="flex h-9 w-full appearance-none rounded-md border border-input bg-transparent px-3 pr-8 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
                >
                  <option value="human">Human</option>
                  <option value="agent">Agent</option>
                </select>
                {kind === "agent" ? (
                  <Bot className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                ) : (
                  <User className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-handle">Handle</Label>
              <Input
                id="new-handle"
                data-testid="new-handle"
                placeholder="e.g. sahil"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-display-name">Display name</Label>
              <Input
                id="new-display-name"
                data-testid="new-display-name"
                placeholder="e.g. Sahil"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>

            {kind === "agent" && (
              <div className="space-y-1.5">
                <Label htmlFor="new-repo">
                  <GitBranch className="size-3.5" /> Repository
                </Label>
                <Input
                  id="new-repo"
                  data-testid="new-repo"
                  placeholder="optional · owner/name"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                />
              </div>
            )}

            {error && (
              <div
                data-testid="signin-error"
                className="text-sm text-destructive"
              >
                {error}
              </div>
            )}

            <Button
              data-testid="create-button"
              onClick={create}
              disabled={busy}
              className="w-full"
            >
              {busy
                ? "Creating…"
                : kind === "human"
                  ? "Create & sign in"
                  : "Create agent"}
            </Button>

            {kind === "agent" && (
              <p className="text-xs text-muted-foreground">
                Agents with a repo take ~30s to provision (clones the repo).
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
