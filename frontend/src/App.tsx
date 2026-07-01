import { useEffect, useMemo, useRef, useState } from "react";
import {
  listChannels,
  getMessages,
  listParticipants,
  createChannel,
  createDm,
  createParticipant,
  listChannelMembers,
  addChannelMember,
  removeChannelMember,
  deleteChannel,
  WS_BASE,
  type Channel,
  type Message,
  type Participant,
} from "./api";
import { SignIn } from "./SignIn";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { avatarClass, initials } from "@/lib/people";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RepoCombobox } from "./RepoCombobox";
import { Markdown } from "./Markdown";
import {
  Bot,
  GitBranch,
  Hash,
  LogOut,
  MessagesSquare,
  MoreVertical,
  Plus,
  SendHorizonal,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";

function mergeById(a: Message[], b: Message[]): Message[] {
  const map = new Map<string, Message>();
  for (const m of [...a, ...b]) map.set(m.id, m);
  return [...map.values()].sort((x, y) => Number(x.seq) - Number(y.seq));
}

// If the caret sits inside an "@…" token (an @ at the start or after whitespace, with no
// whitespace up to the caret), return where it starts and the text typed so far. Used to
// drive the @-mention autocomplete. Returns null when there's no active mention token.
function detectMention(text: string, caret: number): { start: number; query: string } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      const before = i === 0 ? " " : text[i - 1];
      return /\s/.test(before) ? { start: i, query: text.slice(i + 1, caret) } : null;
    }
    if (/\s/.test(ch)) return null; // whitespace before any '@' — not in a mention
  }
  return null;
}

// Works in non-secure contexts (e.g. http://<ip>) where crypto.randomUUID is undefined.
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// Animated "•••" used in the working indicator.
function WorkingDots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-bounce rounded-full bg-primary"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}

export function App({
  authParticipantId,
  getWsToken,
  me: meProp,
  onSignOut,
}: {
  authParticipantId?: string; // from Firebase onboarding; overrides the ?as= dev path
  getWsToken?: () => Promise<string | null>; // fresh ID token for the WS handshake
  me?: Participant; // current user (Firebase mode)
  onSignOut?: () => void; // Firebase sign-out (else clears ?as=)
} = {}) {
  const participantId = authParticipantId ?? new URLSearchParams(location.search).get("as");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [people, setPeople] = useState<Participant[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState<Record<string, string[]>>({}); // channelId -> agent handles
  // New-channel form
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMembers, setNewMembers] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  // Add-agent form
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [agHandle, setAgHandle] = useState("");
  const [agName, setAgName] = useState("");
  const [agRepo, setAgRepo] = useState("");
  const [addingAgent, setAddingAgent] = useState(false);
  // Channel members panel + delete
  const [members, setMembers] = useState<Participant[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [memberBusy, setMemberBusy] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // @-mention autocomplete
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const selectedRef = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  selectedRef.current = selected;

  const me = meProp ?? people.find((p) => p.id === participantId);

  function reloadChannels(selectId?: string) {
    if (!participantId) return;
    listChannels(participantId).then((cs) => {
      setChannels(cs);
      // Keep the current selection only if it still exists; otherwise fall back to the first.
      setSelected((s) => selectId ?? (cs.some((c) => c.id === s) ? s : cs[0]?.id ?? null));
    });
  }

  function refreshMembers() {
    if (!selected) return;
    listChannelMembers(selected).then(setMembers).catch(() => {});
  }

  async function addMember(handle: string) {
    if (!selected || memberBusy) return;
    setMemberBusy(true);
    try {
      await addChannelMember(selected, handle);
      setAddQuery("");
      refreshMembers();
      reloadChannels(selected);
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    } finally {
      setMemberBusy(false);
    }
  }

  async function removeMember(p: Participant) {
    if (!selected || memberBusy) return;
    setMemberBusy(true);
    try {
      await removeChannelMember(selected, p.id);
      if (p.id === participantId) {
        // Removed myself — leave the channel view and refresh my channel list.
        setShowMembers(false);
        setSelected(null);
        reloadChannels();
      } else {
        refreshMembers();
      }
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    } finally {
      setMemberBusy(false);
    }
  }

  async function confirmDeleteChannel() {
    if (!selected || deleting) return;
    setDeleting(true);
    try {
      await deleteChannel(selected);
      setShowDeleteConfirm(false);
      setShowMembers(false);
      setSelected(null);
      reloadChannels();
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    } finally {
      setDeleting(false);
    }
  }

  // Channels this participant belongs to + everyone (for the member picker).
  useEffect(() => {
    if (!participantId) return;
    reloadChannels();
    listParticipants().then(setPeople).catch(() => {});
  }, [participantId]);

  // Load history when the selected channel changes.
  useEffect(() => {
    if (!selected) return;
    getMessages(selected).then(setMessages);
  }, [selected]);

  // Load the member roster for the selected channel (powers the header count + members panel).
  useEffect(() => {
    setAddQuery("");
    if (!selected) {
      setMembers([]);
      return;
    }
    listChannelMembers(selected).then(setMembers).catch(() => setMembers([]));
  }, [selected]);

  // Keep the message list pinned to the newest message.
  useEffect(() => {
    const vp = viewportRef.current;
    if (vp) vp.scrollTop = vp.scrollHeight;
  }, [messages, selected]);

  // One auto-reconnecting WebSocket. On (re)connect, backfill history for the open
  // channel so anything that arrived while disconnected isn't missed (cross-device).
  useEffect(() => {
    if (!participantId) return;
    let stopped = false;
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      // Firebase mode: authenticate the socket with a fresh ID token. Dev mode: ?participantId=.
      const qs = getWsToken
        ? `token=${encodeURIComponent((await getWsToken()) ?? "")}`
        : `participantId=${encodeURIComponent(participantId)}`;
      if (stopped) return;
      ws = new WebSocket(`${WS_BASE}/?${qs}`);
      wsRef.current = ws;
      ws.onopen = () => {
        setNotice("");
        const ch = selectedRef.current;
        if (ch)
          getMessages(ch).then((hist) =>
            setMessages((prev) => mergeById(prev, hist)),
          );
      };
      ws.onmessage = (e) => {
        const evt = JSON.parse(e.data);
        if (evt.type === "agent_status") {
          setWorking((w) => {
            const set = new Set(w[evt.channelId] ?? []);
            if (evt.state === "working") set.add(evt.handle);
            else set.delete(evt.handle);
            return { ...w, [evt.channelId]: [...set] };
          });
          return;
        }
        if (evt.type === "members_changed") {
          if (evt.channelId === selectedRef.current)
            listChannelMembers(evt.channelId).then(setMembers).catch(() => {});
          return;
        }
        if (evt.type === "channel_deleted") {
          setChannels((cs) => cs.filter((c) => c.id !== evt.channelId));
          if (evt.channelId === selectedRef.current) setSelected(null);
          return;
        }
        if (evt.type !== "message") return;
        const m: Message = evt.message;
        if (m.channel_id !== selectedRef.current) return;
        setMessages((prev) =>
          prev.some((x) => x.id === m.id) ? prev : [...prev, m],
        );
      };
      ws.onclose = () => {
        if (!stopped) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [participantId]);

  function send() {
    const body = draft.trim();
    if (!body) return;
    if (!selected) {
      setNotice("Pick or create a channel first.");
      return;
    }
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setNotice("Connecting to the server… try again in a moment.");
      return;
    }
    // No optimistic echo — the message appears when it round-trips back over WS,
    // which proves the full send -> persist -> fan-out -> render loop.
    wsRef.current.send(
      JSON.stringify({ type: "post", channelId: selected, body, clientMsgId: newId() }),
    );
    setDraft("");
    setMention(null);
    setNotice("");
  }

  // Candidates for the @-mention popup: everyone but me, matching the typed query, with
  // current channel members surfaced first, then handle-prefix matches.
  const mentionCandidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const memberIds = new Set(members.map((m) => m.id));
    return people
      .filter((p) => p.id !== participantId)
      .filter(
        (p) =>
          !q ||
          p.handle.toLowerCase().includes(q) ||
          p.display_name.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const am = memberIds.has(a.id) ? 0 : 1;
        const bm = memberIds.has(b.id) ? 0 : 1;
        if (am !== bm) return am - bm;
        const asw = a.handle.toLowerCase().startsWith(q) ? 0 : 1;
        const bsw = b.handle.toLowerCase().startsWith(q) ? 0 : 1;
        if (asw !== bsw) return asw - bsw;
        return a.display_name.localeCompare(b.display_name);
      })
      .slice(0, 8);
  }, [mention, people, members, participantId]);

  // Recompute the active mention token from the textarea's current value + caret.
  function syncMention(value: string, caret: number) {
    setMention(detectMention(value, caret));
    setMentionIndex(0);
  }

  // Replace the in-progress "@query" token with "@handle " and drop the popup.
  function acceptMention(p: Participant) {
    const m = mention;
    const ta = taRef.current;
    if (!m) return;
    const caret = ta?.selectionStart ?? m.start + 1 + m.query.length;
    const before = draft.slice(0, m.start);
    const after = draft.slice(caret);
    const insert = `@${p.handle} `;
    const next = before + insert + after;
    setDraft(next);
    setMention(null);
    const pos = (before + insert).length;
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      }
    });
  }

  async function submitNewChannel() {
    const name = newName.trim();
    if (!name || !me) {
      setNotice("Channel name is required.");
      return;
    }
    setCreating(true);
    try {
      const handles = [...new Set([me.handle, ...newMembers])]; // always include yourself
      const ch = await createChannel({ name, kind: "channel", memberHandles: handles });
      setShowNew(false);
      setNewName("");
      setNewMembers([]);
      reloadChannels(ch.id);
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    } finally {
      setCreating(false);
    }
  }

  function signOut() {
    if (onSignOut) onSignOut(); // Firebase sign-out
    else window.location.search = ""; // dev path: drop ?as= -> back to the sign-in screen
  }

  async function openDm(otherId: string) {
    if (!participantId) return;
    try {
      const { id } = await createDm(participantId, otherId);
      reloadChannels(id);
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    }
  }

  async function submitAddAgent() {
    if (!agHandle.trim() || !agName.trim()) {
      setNotice("Agent handle and name are required.");
      return;
    }
    setAddingAgent(true);
    try {
      await createParticipant({
        kind: "agent",
        handle: agHandle.trim(),
        displayName: agName.trim(),
        repo: agRepo.trim() || undefined,
      });
      setShowAddAgent(false);
      setAgHandle("");
      setAgName("");
      setAgRepo("");
      listParticipants().then(setPeople).catch(() => {});
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    } finally {
      setAddingAgent(false);
    }
  }

  // Group consecutive messages by the same sender for a cleaner, Slack-like feed.
  const grouped = useMemo(() => {
    const out: { lead: Message; rest: Message[] }[] = [];
    for (const m of messages) {
      const last = out[out.length - 1];
      if (last && last.lead.sender_id === m.sender_id) last.rest.push(m);
      else out.push({ lead: m, rest: [] });
    }
    return out;
  }, [messages]);

  if (!participantId) return <SignIn />;

  const sel = channels.find((c) => c.id === selected);
  const others = people.filter((p) => p.id !== participantId);
  const rooms = channels.filter((c) => c.kind !== "dm");
  const dms = channels.filter((c) => c.kind === "dm");
  const dmChannelWith = (handle: string) => dms.find((c) => c.dm_with === handle);
  const personByHandle = (h?: string | null) =>
    h ? people.find((p) => p.handle === h) : undefined;
  const workingHere = (selected && working[selected]) || [];

  const headerTitle = sel
    ? sel.kind === "dm"
      ? `@${sel.dm_with ?? "dm"}`
      : sel.name
    : null;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {/* ---------- Sidebar ---------- */}
      <aside className="flex w-72 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
        {/* Workspace header */}
        <div className="flex shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4 py-3.5">
          <img src="/icon-192.png" alt="Jungle" className="size-8 rounded-lg shadow-sm" />
          <div className="min-w-0">
            <div className="truncate font-bold leading-tight">Jungle</div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-2 py-3">
            {/* Channels */}
            <SectionHeader
              label="Channels"
              actionLabel="New channel"
              onAction={() => setShowNew(true)}
              actionTestId="new-channel-toggle"
            />
            {rooms.map((c) => (
              <NavItem
                key={c.id}
                testId="channel-item"
                active={c.id === selected}
                onClick={() => setSelected(c.id)}
                icon={<Hash className="size-4 opacity-70" />}
                label={c.name}
                working={(working[c.id]?.length ?? 0) > 0}
              />
            ))}
            {rooms.length === 0 && (
              <EmptyHint>No channels yet.</EmptyHint>
            )}

            {/* Direct messages */}
            {dms.length > 0 && (
              <>
                <div className="h-3" />
                <SectionHeader label="Direct messages" />
                {dms.map((c) => {
                  const p = personByHandle(c.dm_with);
                  return (
                    <NavItem
                      key={c.id}
                      testId="channel-item"
                      active={c.id === selected}
                      onClick={() => setSelected(c.id)}
                      icon={
                        <PersonAvatar
                          name={p?.display_name ?? c.dm_with ?? "?"}
                          handle={c.dm_with ?? "?"}
                          size="sm"
                        />
                      }
                      label={p?.display_name ?? c.dm_with ?? "dm"}
                      title={c.dm_with ? `@${c.dm_with}` : undefined}
                      working={(working[c.id]?.length ?? 0) > 0}
                    />
                  );
                })}
              </>
            )}

            {/* People */}
            <div className="h-3" />
            <SectionHeader
              label="People"
              actionLabel="Add agent"
              onAction={() => setShowAddAgent(true)}
              actionTestId="add-agent-toggle"
            />
            {others.map((p) => (
              <NavItem
                key={p.id}
                testId="people-item"
                active={false}
                onClick={() => {
                  const existing = dmChannelWith(p.handle);
                  if (existing) setSelected(existing.id);
                  else openDm(p.id);
                }}
                icon={
                  <PersonAvatar
                    name={p.display_name}
                    handle={p.handle}
                    size="sm"
                  />
                }
                label={p.display_name}
                title={`@${p.handle}`}
                trailing={
                  p.kind === "agent" ? (
                    <Bot className="size-3.5 text-sidebar-foreground/50" />
                  ) : undefined
                }
              />
            ))}
            {others.length === 0 && <EmptyHint>No one else yet.</EmptyHint>}
          </div>
        </div>

        {/* User footer */}
        {me && (
          <div className="flex shrink-0 items-center gap-2.5 border-t border-sidebar-border px-3 py-2.5">
            <PersonAvatar name={me.display_name} handle={me.handle} />
            <div className="min-w-0 flex-1" title={`@${me.handle}`}>
              <div className="truncate text-sm font-semibold">
                {me.display_name}
              </div>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-testid="switch-user"
                  onClick={signOut}
                  title="Switch user"
                  className="flex size-8 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                >
                  <LogOut className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Switch user</TooltipContent>
            </Tooltip>
          </div>
        )}
      </aside>

      {/* ---------- Main ---------- */}
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        {/* Channel header */}
        <header className="flex h-14 shrink-0 items-center gap-2.5 border-b px-5">
          {sel ? (
            <>
              {sel.kind === "dm" ? (
                <PersonAvatar
                  name={personByHandle(sel.dm_with)?.display_name ?? sel.dm_with ?? "?"}
                  handle={sel.dm_with ?? "?"}
                  size="sm"
                />
              ) : (
                <Hash className="size-5 text-muted-foreground" />
              )}
              <h2 className="truncate font-semibold">{headerTitle}</h2>

              {sel.kind !== "dm" && (
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="members-button"
                    onClick={() => setShowMembers(true)}
                    className="h-8 gap-1.5 rounded-full px-2.5 text-muted-foreground"
                    title="Members"
                  >
                    <Users className="size-4" />
                    <span className="text-xs font-medium tabular-nums">{members.length}</span>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground"
                        data-testid="channel-menu"
                        title="Channel settings"
                      >
                        <MoreVertical className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem
                        data-testid="menu-members"
                        onClick={() => setShowMembers(true)}
                      >
                        <UserPlus className="size-4" />
                        Members
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        data-testid="menu-delete-channel"
                        onClick={() => setShowDeleteConfirm(true)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="size-4" />
                        Delete channel
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </>
          ) : (
            <h2 className="font-semibold text-muted-foreground">
              Select or create a channel
            </h2>
          )}
        </header>

        {/* Messages */}
        <div ref={viewportRef} className="min-h-0 flex-1 overflow-y-auto">
          <div data-testid="message-list" className="flex flex-col gap-5 px-5 py-6">
            {sel && grouped.length === 0 && (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 pt-16 text-center">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-muted">
                  <MessagesSquare className="size-6 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  This is the start of {headerTitle}. Say something — or{" "}
                  <span className="font-medium text-foreground">@mention</span>{" "}
                  an agent to put it to work.
                </p>
              </div>
            )}

            {grouped.map(({ lead, rest }) => {
              const sender = personByHandle(lead.sender_handle);
              const isAgent = sender?.kind === "agent";
              return (
                <div key={lead.id} className="flex gap-3">
                  <PersonAvatar
                    name={sender?.display_name ?? lead.sender_handle}
                    handle={lead.sender_handle}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span
                        data-testid="message-sender"
                        className="font-semibold"
                      >
                        {sender?.display_name ?? lead.sender_handle}
                      </span>
                      {isAgent && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          <Sparkles className="size-2.5" /> agent
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {fmtTime(lead.created_at)}
                      </span>
                    </div>
                    <div data-testid="message" className="break-words">
                      <Markdown>{lead.body}</Markdown>
                    </div>
                    {rest.map((m) => (
                      <div key={m.id} data-testid="message" className="mt-1 break-words">
                        <Markdown>{m.body}</Markdown>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Working indicator (conditionally rendered: absent when idle) */}
        {workingHere.length > 0 && (
          <div
            data-testid="working-indicator"
            className="flex items-center gap-2 px-5 py-1.5 text-sm text-muted-foreground"
          >
            <WorkingDots />
            <span>
              <span className="font-medium text-foreground">
                {workingHere.map((h) => `@${h}`).join(", ")}
              </span>{" "}
              {workingHere.length > 1 ? "are" : "is"} working…
            </span>
          </div>
        )}

        {/* Notice */}
        {notice && (
          <div
            data-testid="send-notice"
            className="mx-5 mb-1 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
          >
            {notice}
          </div>
        )}

        {/* Composer */}
        <div className="px-5 pb-5 pt-1">
          <div className="relative flex items-end gap-2 rounded-xl border bg-card p-2 shadow-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20">
            {/* @-mention autocomplete */}
            {mention && mentionCandidates.length > 0 && (
              <div
                data-testid="mention-popup"
                className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
              >
                <div className="max-h-64 overflow-y-auto p-1">
                  {mentionCandidates.map((p, i) => (
                    <button
                      key={p.id}
                      data-testid="mention-option"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        acceptMention(p);
                      }}
                      onMouseEnter={() => setMentionIndex(i)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm",
                        i === mentionIndex ? "bg-accent" : "hover:bg-accent/60",
                      )}
                    >
                      <PersonAvatar name={p.display_name} handle={p.handle} size="sm" />
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="truncate font-medium">{p.display_name}</span>
                        <span className="truncate text-muted-foreground">@{p.handle}</span>
                        {p.kind === "agent" && <Bot className="size-3.5 shrink-0 text-primary" />}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <Textarea
              ref={taRef}
              data-testid="composer-input"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onSelect={(e) => {
                const t = e.target as HTMLTextAreaElement;
                syncMention(t.value, t.selectionStart ?? 0);
              }}
              onKeyDown={(e) => {
                if (mention && mentionCandidates.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMentionIndex((i) => (i + 1) % mentionCandidates.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMentionIndex(
                      (i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length,
                    );
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    acceptMention(mentionCandidates[mentionIndex]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setMention(null);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder={
                headerTitle
                  ? `Message ${sel?.kind === "dm" ? headerTitle : "#" + headerTitle}`
                  : "Select or create a channel"
              }
              className="max-h-40 min-h-9 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
            />
            <Button
              data-testid="send-button"
              onClick={send}
              size="icon"
              className="shrink-0"
              aria-label="Send"
            >
              <SendHorizonal className="size-4" />
            </Button>
          </div>
        </div>
      </main>

      {/* ---------- New channel dialog ---------- */}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a channel</DialogTitle>
            <DialogDescription>
              Channels are where your team and agents work together.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-channel-name">Name</Label>
              <div className="relative">
                <Hash className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="new-channel-name"
                  data-testid="new-channel-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. deploys"
                  className="pl-8"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Members (you're always included)</Label>
              <div className="max-h-52 space-y-0.5 overflow-y-auto rounded-lg border p-1">
                {others.map((p) => {
                  const on = newMembers.includes(p.handle);
                  return (
                    <label
                      key={p.id}
                      data-testid="member-option"
                      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                    >
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--primary)]"
                        checked={on}
                        onChange={() =>
                          setNewMembers((m) =>
                            on ? m.filter((h) => h !== p.handle) : [...m, p.handle],
                          )
                        }
                      />
                      <PersonAvatar name={p.display_name} handle={p.handle} size="sm" />
                      <span className="flex items-center gap-1">
                        @{p.handle}
                        {p.kind === "agent" && (
                          <Bot className="size-3.5 text-primary" />
                        )}
                      </span>
                    </label>
                  );
                })}
                {others.length === 0 && (
                  <div className="px-2 py-3 text-sm text-muted-foreground">
                    No one else yet.
                  </div>
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              data-testid="create-channel-button"
              onClick={submitNewChannel}
              disabled={creating}
            >
              {creating ? "Creating…" : "Create channel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- Channel members dialog ---------- */}
      <Dialog open={showMembers} onOpenChange={setShowMembers}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <Hash className="size-4 text-muted-foreground" />
              {sel?.name} · members
            </DialogTitle>
            <DialogDescription>Add or remove who has access to this channel.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {/* Add people */}
            <div className="space-y-1.5">
              <div className="relative">
                <UserPlus className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  data-testid="member-add-input"
                  value={addQuery}
                  onChange={(e) => setAddQuery(e.target.value)}
                  placeholder="Add people or agents by name…"
                  className="pl-8"
                  disabled={memberBusy}
                />
              </div>
              {addQuery.trim() && (
                <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border p-1">
                  {(() => {
                    const q = addQuery.trim().toLowerCase();
                    const addable = others.filter(
                      (p) =>
                        !members.some((m) => m.id === p.id) &&
                        (p.display_name.toLowerCase().includes(q) || p.handle.toLowerCase().includes(q)),
                    );
                    if (!addable.length)
                      return <div className="px-2 py-2 text-sm text-muted-foreground">No matches.</div>;
                    return addable.map((p) => (
                      <button
                        key={p.id}
                        data-testid="member-add-option"
                        onClick={() => addMember(p.handle)}
                        disabled={memberBusy}
                        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                      >
                        <PersonAvatar name={p.display_name} handle={p.handle} size="sm" />
                        <span className="flex min-w-0 items-center gap-1">
                          <span className="truncate">{p.display_name}</span>
                          <span className="truncate text-muted-foreground">@{p.handle}</span>
                          {p.kind === "agent" && <Bot className="size-3.5 shrink-0 text-primary" />}
                        </span>
                      </button>
                    ));
                  })()}
                </div>
              )}
            </div>

            {/* Current members */}
            <div className="max-h-72 space-y-0.5 overflow-y-auto">
              {members.map((p) => (
                <div
                  key={p.id}
                  data-testid="member-row"
                  className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent"
                >
                  <PersonAvatar name={p.display_name} handle={p.handle} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 truncate text-sm font-medium">
                      {p.display_name}
                      {p.kind === "agent" && <Bot className="size-3.5 shrink-0 text-primary" />}
                      {p.id === participantId && (
                        <span className="text-xs font-normal text-muted-foreground">(you)</span>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">@{p.handle}</div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    data-testid="member-remove"
                    onClick={() => removeMember(p)}
                    disabled={memberBusy}
                    title={p.id === participantId ? "Leave channel" : `Remove @${p.handle}`}
                    className="size-7 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ))}
              {members.length === 0 && (
                <div className="px-2 py-3 text-sm text-muted-foreground">No members yet.</div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ---------- Delete channel confirm ---------- */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete #{sel?.name}?</DialogTitle>
            <DialogDescription>
              This permanently deletes the channel and all of its messages for everyone. This can't
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDeleteConfirm(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="confirm-delete-channel"
              onClick={confirmDeleteChannel}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete channel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- Add agent dialog ---------- */}
      <Dialog open={showAddAgent} onOpenChange={setShowAddAgent}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bot className="size-5 text-primary" /> Add an agent
            </DialogTitle>
            <DialogDescription>
              A persistent, cloud-living assistant. Give it a repo and it can open
              real PRs.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="agent-handle">Handle</Label>
              <Input
                id="agent-handle"
                data-testid="agent-handle"
                value={agHandle}
                onChange={(e) => setAgHandle(e.target.value)}
                placeholder="e.g. deploy-bot"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-name">Display name</Label>
              <Input
                id="agent-name"
                data-testid="agent-name"
                value={agName}
                onChange={(e) => setAgName(e.target.value)}
                placeholder="e.g. Deploy Bot"
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                <GitBranch className="size-3.5" /> Repository{" "}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <RepoCombobox value={agRepo} onChange={setAgRepo} />
              {agRepo.trim() && (
                <p className="text-xs text-muted-foreground">
                  With a repo this takes ~30s (clones it).
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              data-testid="add-agent-button"
              onClick={submitAddAgent}
              disabled={addingAgent}
            >
              {addingAgent ? "Adding…" : "Add agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ----------------------------- small pieces ----------------------------- */

function SectionHeader({
  label,
  actionLabel,
  onAction,
  actionTestId,
}: {
  label: string;
  actionLabel?: string;
  onAction?: () => void;
  actionTestId?: string;
}) {
  return (
    <div className="flex items-center justify-between px-2 pb-1 pt-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-sidebar-foreground/50">
        {label}
      </span>
      {onAction && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              data-testid={actionTestId}
              onClick={onAction}
              className="flex size-5 items-center justify-center rounded text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <Plus className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{actionLabel}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function NavItem({
  testId,
  active,
  onClick,
  icon,
  label,
  trailing,
  working,
  title,
}: {
  testId: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  working?: boolean;
  title?: string;
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      title={title}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {working && (
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />
      )}
      {trailing}
    </button>
  );
}

function PersonAvatar({
  name,
  handle,
  size = "md",
}: {
  name: string;
  handle: string;
  size?: "sm" | "md";
}) {
  return (
    <Avatar className={size === "sm" ? "size-5 rounded" : "size-8 rounded-md"}>
      <AvatarFallback
        className={cn(
          avatarClass(handle),
          size === "sm" ? "rounded text-[9px]" : "rounded-md text-xs",
        )}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 py-1 text-xs text-sidebar-foreground/40">{children}</div>
  );
}
