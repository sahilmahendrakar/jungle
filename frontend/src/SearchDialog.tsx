import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Hash, Loader2, MessageSquare } from "lucide-react";
import { searchMessages, type Channel, type Participant, type SearchResult } from "./api";
import { fmtRelative } from "./lib/chat";
import { PersonAvatar } from "./components/chat/panels";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

// ⌘K: one box to jump anywhere — channels and people filter instantly client-side; messages are
// full-text searched server-side (debounced) across everything you're a member of. This is how a
// week-old agent decision gets found again.

const DEBOUNCE_MS = 250;

function snippet(body: string): string {
  const line = body
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1") // markdown links -> their text
    .replace(/[#*`>_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

export function SearchDialog({
  open,
  onOpenChange,
  channels,
  people,
  participantId,
  onSelectChannel,
  onOpenDm,
  onJumpToMessage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channels: Channel[];
  people: Participant[];
  participantId: string | null;
  onSelectChannel: (channelId: string) => void;
  onOpenDm: (participantId: string) => void;
  onJumpToMessage: (r: SearchResult) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset per open so yesterday's query doesn't flash.
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
    }
  }, [open]);

  // Debounced server search. A stale response for an older query is dropped by comparing q.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      searchMessages(q)
        .then((rs) => {
          setResults(rs);
          setSearching(false);
        })
        .catch(() => setSearching(false));
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const q = query.trim().toLowerCase();
  const matchedChannels = useMemo(
    () =>
      channels
        .filter((c) => c.kind !== "dm" && (!q || c.name.toLowerCase().includes(q)))
        .slice(0, 5),
    [channels, q],
  );
  const matchedPeople = useMemo(
    () =>
      people
        .filter((p) => p.id !== participantId)
        .filter(
          (p) => !q || p.handle.toLowerCase().includes(q) || p.display_name.toLowerCase().includes(q),
        )
        .slice(0, 5),
    [people, q],
  );

  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="search-dialog"
        className="top-[20%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        {/* shouldFilter off: channels/people are pre-filtered above; messages come from the server. */}
        <Command shouldFilter={false} className="bg-transparent">
          <CommandInput
            data-testid="search-input"
            value={query}
            onValueChange={setQuery}
            placeholder="Search messages, channels, people…"
          />
          <CommandList className="max-h-[26rem]">
            {!searching && <CommandEmpty>No matches.</CommandEmpty>}
            {matchedChannels.length > 0 && (
              <CommandGroup heading="Channels">
                {matchedChannels.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={`channel-${c.id}`}
                    onSelect={() => {
                      onSelectChannel(c.id);
                      close();
                    }}
                  >
                    <Hash className="size-4 text-muted-foreground" />
                    <span className="truncate">{c.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {matchedPeople.length > 0 && (
              <CommandGroup heading="People">
                {matchedPeople.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`person-${p.id}`}
                    onSelect={() => {
                      onOpenDm(p.id);
                      close();
                    }}
                  >
                    <PersonAvatar name={p.display_name} handle={p.handle} size="sm" />
                    <span className="truncate">{p.display_name}</span>
                    <span className="truncate text-muted-foreground">@{p.handle}</span>
                    {p.kind === "agent" && <Bot className="size-3.5 shrink-0 text-primary" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {(results.length > 0 || searching) && (
              <CommandGroup heading="Messages">
                {searching && results.length === 0 && (
                  <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Searching…
                  </div>
                )}
                {results.map((r) => (
                  <CommandItem
                    key={r.message_id}
                    value={`msg-${r.message_id}`}
                    data-testid="search-result-message"
                    onSelect={() => {
                      onJumpToMessage(r);
                      close();
                    }}
                    className="items-start"
                  >
                    <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{snippet(r.body)}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        @{r.sender_handle} in{" "}
                        {r.channel_kind === "dm" ? `@${r.dm_with ?? "dm"}` : `#${r.channel_name}`} ·{" "}
                        {fmtRelative(r.created_at)}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
