import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Hash, Loader2, MessageSquare, Package, SlidersHorizontal } from "lucide-react";
import { searchMessages, type Channel, type Deliverable, type Participant, type SearchResult } from "./api";
import { fmtRelative, snippet } from "./lib/chat";
import { IS_TOKENS, KIND_LABELS, KIND_TOKENS, TYPE_TOKENS, tokenAtCaret } from "./lib/filterTokens";
import { PersonAvatar } from "./components/chat/panels";
import { DELIVERABLE_KIND_META } from "./components/chat/deliverableCards";
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
// full-text searched server-side (debounced) across everything you're a member of. The query
// speaks the shared filter-token language (from:@pip, in:#general, is:sent, kind:pr — see
// lib/filterTokens.ts); `type:deliverables` switches the search to the deliverables index.

const DEBOUNCE_MS = 250;

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
  const [deliverables, setDeliverables] = useState<Deliverable[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset per open so yesterday's query doesn't flash.
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setDeliverables([]);
    }
  }, [open]);

  // Debounced server search. A stale response for an older query is dropped by comparing q.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setDeliverables([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      searchMessages(q)
        .then((r) => {
          setResults(r.results);
          setDeliverables(r.deliverables);
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

  // Filter-token autocomplete: the trailing word is an in-progress token (from:ec, in:#gen) →
  // offer completions. Selecting one splices it in and keeps the palette open.
  const tokenSuggestions: { label: string; insert: string }[] = useMemo(() => {
    const active = tokenAtCaret(query, query.length);
    if (!active) return [];
    const prefix = active.value.replace(/^[@#]+/, "").toLowerCase();
    switch (active.key) {
      case "from":
      case "to":
        return people
          .filter((p) => p.handle.toLowerCase().startsWith(prefix))
          .slice(0, 5)
          .map((p) => ({ label: `${active.key}:@${p.handle} — ${p.display_name}`, insert: `${active.key}:@${p.handle}` }));
      case "in": {
        const rooms = channels
          .filter((c) => c.kind !== "dm" && c.name.toLowerCase().startsWith(prefix))
          .slice(0, 4)
          .map((c) => ({ label: `in:#${c.name}`, insert: `in:#${c.name}` }));
        const dms = active.value.startsWith("@")
          ? people
              .filter((p) => p.handle.toLowerCase().startsWith(prefix))
              .slice(0, 4)
              .map((p) => ({ label: `in:@${p.handle} (DM)`, insert: `in:@${p.handle}` }))
          : [];
        return [...rooms, ...dms].slice(0, 5);
      }
      case "type":
        return TYPE_TOKENS.filter((t) => t.startsWith(prefix)).map((t) => ({
          label: `type:${t}`,
          insert: `type:${t}`,
        }));
      case "kind":
        return KIND_TOKENS.filter((t) => t.startsWith(prefix)).map((t) => ({
          label: `kind:${t} — ${KIND_LABELS[t]}`,
          insert: `kind:${t}`,
        }));
      case "is":
        return IS_TOKENS.filter((t) => t.startsWith(prefix)).map((t) => ({
          label: `is:${t}`,
          insert: `is:${t}`,
        }));
      default:
        return [];
    }
  }, [query, people, channels]);

  function acceptToken(insert: string) {
    const active = tokenAtCaret(query, query.length);
    if (!active) return;
    setQuery(`${query.slice(0, active.start)}${insert} `);
  }

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
            placeholder="Search — try from:@pip, in:#general, type:deliverables…"
          />
          <CommandList className="max-h-[26rem]">
            {!searching && <CommandEmpty>No matches.</CommandEmpty>}
            {!q && (
              <div className="flex items-start gap-2 px-3 py-2.5 text-xs text-muted-foreground">
                <SlidersHorizontal className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Compose filters with your search:{" "}
                  <span className="font-medium text-foreground/80">from:@pip</span>,{" "}
                  <span className="font-medium text-foreground/80">to:@sahil</span>,{" "}
                  <span className="font-medium text-foreground/80">in:#general</span>,{" "}
                  <span className="font-medium text-foreground/80">is:sent</span>,{" "}
                  <span className="font-medium text-foreground/80">type:deliverables</span>,{" "}
                  <span className="font-medium text-foreground/80">kind:pr</span>
                </span>
              </div>
            )}
            {tokenSuggestions.length > 0 && (
              <CommandGroup heading="Filters">
                {tokenSuggestions.map((s) => (
                  <CommandItem
                    key={s.insert}
                    value={`filter-${s.insert}`}
                    data-testid="search-filter-suggestion"
                    onSelect={() => acceptToken(s.insert)}
                  >
                    <SlidersHorizontal className="size-4 text-muted-foreground" />
                    <span className="truncate">{s.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
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
            {(results.length > 0 || (searching && deliverables.length === 0)) && (
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
            {deliverables.length > 0 && (
              <CommandGroup heading="Deliverables">
                {deliverables.map((d) => {
                  const meta = DELIVERABLE_KIND_META[d.kind];
                  const Icon = meta?.icon ?? Package;
                  return (
                    <CommandItem
                      key={d.id}
                      value={`deliv-${d.id}`}
                      data-testid="search-result-deliverable"
                      onSelect={() => {
                        onJumpToMessage({
                          message_id: d.message_id,
                          channel_id: d.channel_id,
                          channel_name: d.channel_name,
                          channel_kind: d.channel_kind,
                          dm_with: null,
                          thread_root_id: null,
                          sender_handle: d.agent_handle,
                          body: d.title ?? d.url,
                          created_at: d.created_at,
                        });
                        close();
                      }}
                      className="items-start"
                    >
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{d.title ?? d.url}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {meta?.label ?? "Link"} · @{d.agent_handle} in{" "}
                          {d.channel_kind === "dm" ? "a DM" : `#${d.channel_name}`} ·{" "}
                          {fmtRelative(d.created_at)}
                        </span>
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
