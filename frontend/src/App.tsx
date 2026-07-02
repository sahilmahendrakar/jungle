import { useEffect, useMemo, useRef, useState } from "react";
import {
  listChannels,
  markChannelRead,
  getMessages,
  listParticipants,
  createChannel,
  createDm,
  createParticipant,
  listChannelMembers,
  addChannelMember,
  removeChannelMember,
  deleteChannel,
  confirmToolCall,
  updateAgent,
  setDevParticipantId,
  WS_BASE,
  type AgentEvent,
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
import { AgentActivity } from "./AgentActivity";
import { navigate } from "./route";
import {
  Activity,
  Bot,
  Check,
  ChevronDown,
  GitBranch,
  Hash,
  LogOut,
  MessagesSquare,
  MoreVertical,
  PanelLeft,
  PanelLeftClose,
  Plus,
  SendHorizonal,
  ShieldQuestion,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";

// Agent model + permission-mode choices for the create-agent dialog. Model ids must match
// the backend's ALLOWED_MODELS; the first entry is the default.
const MODEL_OPTIONS = [
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "Most capable" },
  { id: "claude-sonnet-5", label: "Sonnet 5", hint: "Balanced" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", hint: "Fastest" },
];
// Agent permission modes (SDK runner). `default` is first (the create-agent default).
const SDK_MODE_OPTIONS = [
  {
    id: "default",
    label: "Ask on sensitive",
    hint: "Ask before sensitive tools — safe actions run automatically",
  },
  { id: "acceptEdits", label: "Accept edits", hint: "Auto-accept file edits" },
  { id: "plan", label: "Plan only", hint: "Proposes, never changes files" },
  { id: "bypassPermissions", label: "Full autonomy", hint: "Never asks" },
  { id: "dontAsk", label: "Deny unapproved", hint: "Deny anything not pre-approved" },
];

// A pending tool-call confirmation surfaced by an always_ask agent.
interface ToolConfirm {
  confirmId: string;
  channelId: string;
  agentName: string;
  agentHandle: string;
  tool: string;
  input: unknown;
  status?: "resolved";
  result?: "allow" | "deny";
  by?: string;
}

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
  // In dev mode (no Firebase token) let api.ts authenticate requester-gated calls with this id.
  if (!authParticipantId) setDevParticipantId(participantId);
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
  const [agModel, setAgModel] = useState(MODEL_OPTIONS[0].id);
  const [agMode, setAgMode] = useState(SDK_MODE_OPTIONS[0].id); // new agents are sdk runtime
  const [addingAgent, setAddingAgent] = useState(false);
  // Pending tool-confirmation cards (always_ask agents), keyed by confirmId.
  const [confirms, setConfirms] = useState<ToolConfirm[]>([]);
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
  // Collapsible sidebar (persisted, desktop) + profile dialog (participant id being viewed)
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem("jungle.sidebar") !== "closed",
  );
  // Off-canvas drawer state (mobile only; independent of the desktop persisted preference).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  // Activity view: the sdk agent whose transcript is open, plus a live event buffer for it.
  // We only buffer while a view is open (activityIdRef gates the WS handler), so idle agents
  // don't accumulate unbounded memory.
  const [activityId, setActivityId] = useState<string | null>(null);
  const [activityEvents, setActivityEvents] = useState<AgentEvent[]>([]);
  const activityIdRef = useRef<string | null>(null);
  activityIdRef.current = activityId;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const selectedRef = useRef<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  selectedRef.current = selected;
  // Whether this tab is focused/visible — a message for the open channel only auto-marks-read
  // when the user is actually looking at it (Slack behaviour). Tracked via a ref so the WS
  // handler reads a live value without re-subscribing.
  const focusedRef = useRef<boolean>(
    typeof document === "undefined" ? true : document.visibilityState === "visible" && document.hasFocus(),
  );

  const me = meProp ?? people.find((p) => p.id === participantId);

  function reloadChannels(selectId?: string) {
    if (!participantId) return;
    listChannels(participantId).then((cs) => {
      setChannels(cs);
      // Keep the current selection only if it still exists; otherwise fall back to the first.
      setSelected((s) => selectId ?? (cs.some((c) => c.id === s) ? s : cs[0]?.id ?? null));
    });
  }

  // Mark a channel read: clear its local unread state immediately (optimistic) and tell the
  // backend to advance last_read_seq. Only for humans — the current user always is one.
  function markRead(channelId: string) {
    setChannels((cs) =>
      cs.map((c) =>
        c.id === channelId && ((c.unread_count ?? 0) > 0 || c.has_mention)
          ? { ...c, unread_count: 0, has_mention: false }
          : c,
      ),
    );
    markChannelRead(channelId).catch(() => {});
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

  // Load history when the selected channel changes, and mark it read (Slack: opening a
  // channel clears its unread state).
  useEffect(() => {
    if (!selected) return;
    getMessages(selected).then(setMessages);
    markRead(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // Track tab focus/visibility so an incoming message for the open channel only auto-marks-read
  // when the user is actually looking. On regaining focus while a channel is open, mark it read.
  useEffect(() => {
    const update = () => {
      focusedRef.current =
        document.visibilityState === "visible" && document.hasFocus();
      if (focusedRef.current && selectedRef.current) markRead(selectedRef.current);
    };
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Persist the sidebar open/closed preference and support a ⌘\ / Ctrl+\ toggle (like Slack).
  useEffect(() => {
    localStorage.setItem("jungle.sidebar", sidebarOpen ? "open" : "closed");
  }, [sidebarOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        if (evt.type === "participant_updated" && evt.participant) {
          setPeople((ps) =>
            ps.map((p) => (p.id === evt.participant.id ? { ...p, ...evt.participant } : p)),
          );
          return;
        }
        if (evt.type === "agent_event") {
          // Only buffer live SDK stream messages while that agent's Activity view is open —
          // otherwise we'd grow memory for every agent forever. When closed, drop the frame;
          // the transcript backfills from the events API when reopened.
          if (evt.agentId !== activityIdRef.current) return;
          const e: AgentEvent = {
            // WS frames carry the raw event; synthesize an id/turn shape matching AgentEvent.
            // The events API assigns numeric ids; use event.id when present, else a monotonic
            // fallback so dedupe/order stay stable within the live buffer.
            id: typeof evt.id === "number" ? evt.id : Date.now() + Math.random(),
            turn_id: evt.turnId,
            event: evt.event,
            created_at: new Date().toISOString(),
          };
          setActivityEvents((prev) => [...prev, e]);
          return;
        }
        if (evt.type === "tool_confirmation_request") {
          setConfirms((cs) =>
            cs.some((c) => c.confirmId === evt.confirmId)
              ? cs
              : [
                  ...cs,
                  {
                    confirmId: evt.confirmId,
                    channelId: evt.channelId,
                    agentName: evt.agentName,
                    agentHandle: evt.agentHandle,
                    tool: evt.tool,
                    input: evt.input,
                  },
                ],
          );
          return;
        }
        if (evt.type === "tool_confirmation_resolved") {
          setConfirms((cs) => cs.filter((c) => c.confirmId !== evt.confirmId));
          return;
        }
        if (evt.type !== "message") return;
        const m: Message = evt.message;
        const isOpen = m.channel_id === selectedRef.current;
        const isMine = m.sender_id === participantId;
        if (isOpen && focusedRef.current) {
          // Looking right at this channel — render it and keep the read marker current so it
          // never shows as unread.
          setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
          if (!isMine) markRead(m.channel_id);
          return;
        }
        if (isOpen) {
          // Open but not focused — still render, but leave it marked unread until refocus.
          setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
        }
        // Bump the unread state of any channel that isn't being actively read. Skip my own
        // messages (Slack never marks your own message unread). Mentions of me flip has_mention.
        if (isMine) return;
        const mentionsMe = (m.mentions ?? []).some((x) => x.id === participantId);
        setChannels((cs) =>
          cs.map((c) =>
            c.id === m.channel_id
              ? {
                  ...c,
                  unread_count: (c.unread_count ?? 0) + 1,
                  has_mention: c.has_mention || mentionsMe,
                }
              : c,
          ),
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

  // Select a conversation and, on mobile, close the off-canvas drawer so the conversation
  // shows full-width. (On desktop the drawer isn't used, so this is a harmless no-op there.)
  function selectAndClose(id: string) {
    setSelected(id);
    setDrawerOpen(false);
  }

  async function openDm(otherId: string) {
    if (!participantId) return;
    try {
      const { id } = await createDm(participantId, otherId);
      reloadChannels(id);
      setDrawerOpen(false);
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    }
  }

  // Open an sdk agent's Activity view. Reset the live buffer so it only holds frames that
  // arrive while this view is open (history is fetched inside AgentActivity).
  function openActivity(agentId: string) {
    setActivityEvents([]);
    setActivityId(agentId);
  }

  // "Steer" an agent from the Activity footer: open/find the DM and post a normal message,
  // which flows through the inbox to the agent's next turn (same path as the composer).
  async function steerAgent(agent: Participant, body: string) {
    if (!participantId) return;
    const { id } = await createDm(participantId, agent.id);
    // Ensure the DM shows in the sidebar; select it so the reply lands in view.
    reloadChannels(id);
    const trySend = (attempt = 0) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ type: "post", channelId: id, body, clientMsgId: newId() }),
        );
      } else if (attempt < 20) {
        setTimeout(() => trySend(attempt + 1), 150);
      } else {
        setNotice("Connecting to the server… try again in a moment.");
      }
    };
    trySend();
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
        model: agModel,
        mode: agMode,
      });
      setShowAddAgent(false);
      setAgHandle("");
      setAgName("");
      setAgRepo("");
      setAgModel(MODEL_OPTIONS[0].id);
      setAgMode(SDK_MODE_OPTIONS[0].id);
      listParticipants().then(setPeople).catch(() => {});
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    } finally {
      setAddingAgent(false);
    }
  }

  async function decideConfirm(c: ToolConfirm, decision: "allow" | "deny") {
    setConfirms((cs) => cs.filter((x) => x.confirmId !== c.confirmId)); // optimistic
    try {
      await confirmToolCall(c.confirmId, decision);
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
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
  const profilePerson = profileId
    ? people.find((p) => p.id === profileId) ?? (me?.id === profileId ? me : undefined)
    : undefined;
  const activityAgent = activityId ? people.find((p) => p.id === activityId) : undefined;

  const headerTitle = sel
    ? sel.kind === "dm"
      ? `@${sel.dm_with ?? "dm"}`
      : sel.name
    : null;

  return (
    <div className="relative flex h-screen-dvh w-full overflow-hidden bg-background text-foreground">
      {/* Mobile backdrop: tapping it closes the off-canvas drawer. Desktop (md+) never shows it. */}
      {drawerOpen && (
        <div
          data-testid="sidebar-backdrop"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      )}

      {/* ---------- Sidebar ----------
          Desktop (md+): in-flow, collapsible via width transition (persisted preference).
          Mobile (<md): fixed off-canvas drawer, slid in/out with `drawerOpen`. */}
      <aside
        data-testid="sidebar"
        className={cn(
          "shrink-0 overflow-hidden",
          // Mobile: off-canvas fixed drawer.
          "fixed inset-y-0 left-0 z-40 w-72 transition-transform duration-200 ease-in-out",
          drawerOpen ? "translate-x-0" : "-translate-x-full",
          // Desktop: in-flow width-collapse; reset the mobile transform/positioning.
          "md:static md:z-auto md:translate-x-0 md:transition-[width] md:duration-200 md:ease-in-out",
          sidebarOpen ? "md:w-72" : "md:w-0",
        )}
      >
        <div className="flex h-full w-72 flex-col bg-sidebar text-sidebar-foreground">
        {/* Workspace header */}
        <div className="flex shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4 py-3.5">
          <img src="/icon-192.png" alt="Jungle" className="size-8 rounded-lg shadow-sm" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-bold leading-tight">Jungle</div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                data-testid="sidebar-collapse"
                onClick={() => {
                  setSidebarOpen(false); // desktop: collapse
                  setDrawerOpen(false); // mobile: close the off-canvas drawer
                }}
                className="flex size-8 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground md:size-7"
              >
                <PanelLeftClose className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Collapse sidebar (⌘\)</TooltipContent>
          </Tooltip>
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
            {rooms.map((c) => {
              const unread = (c.unread_count ?? 0) > 0;
              return (
                <NavItem
                  key={c.id}
                  testId="channel-item"
                  active={c.id === selected}
                  onClick={() => selectAndClose(c.id)}
                  icon={<Hash className="size-4 opacity-70" />}
                  label={c.name}
                  working={(working[c.id]?.length ?? 0) > 0}
                  unread={unread}
                  // Slack: regular channel unreads are bold-only; only a mention shows a count badge.
                  badgeCount={c.has_mention ? c.unread_count ?? 0 : 0}
                  badgeMention={c.has_mention}
                />
              );
            })}
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
                  const unread = (c.unread_count ?? 0) > 0;
                  return (
                    <NavItem
                      key={c.id}
                      testId="channel-item"
                      active={c.id === selected}
                      onClick={() => selectAndClose(c.id)}
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
                      unread={unread}
                      // Slack: every DM unread shows a count badge (all DM messages are "to you").
                      badgeCount={c.unread_count ?? 0}
                      badgeMention={c.has_mention}
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
                  if (existing) selectAndClose(existing.id);
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
          <div className="flex shrink-0 items-center gap-1 border-t border-sidebar-border px-2 py-2.5">
            <button
              data-testid="open-profile"
              onClick={() => navigate("/settings")}
              title="Profile & settings"
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-sidebar-accent"
            >
              <PersonAvatar name={me.display_name} handle={me.handle} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{me.display_name}</div>
                <div className="truncate text-xs text-sidebar-foreground/50">@{me.handle}</div>
              </div>
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  data-testid="switch-user"
                  onClick={signOut}
                  title="Switch user"
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
                >
                  <LogOut className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Switch user</TooltipContent>
            </Tooltip>
          </div>
        )}
        </div>
      </aside>

      {/* ---------- Main ---------- */}
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        {/* Channel header */}
        <header className="flex h-14 shrink-0 items-center gap-2.5 border-b px-3 md:px-5">
          {/* Mobile hamburger: opens the off-canvas drawer. Hidden on md+ (desktop uses the
              persisted collapse toggle below instead). */}
          <Button
            variant="ghost"
            size="icon"
            data-testid="sidebar-toggle"
            aria-label="Open menu"
            onClick={() => setDrawerOpen(true)}
            className="-ml-1 size-9 shrink-0 text-muted-foreground md:hidden"
          >
            <PanelLeft className="size-5" />
          </Button>
          {!sidebarOpen && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid="sidebar-expand"
                  onClick={() => setSidebarOpen(true)}
                  className="-ml-2 hidden size-8 shrink-0 text-muted-foreground md:inline-flex"
                >
                  <PanelLeft className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open sidebar (⌘\)</TooltipContent>
            </Tooltip>
          )}
          {sel ? (
            <>
              {sel.kind === "dm" ? (
                <button
                  data-testid="dm-header-profile"
                  onClick={() => {
                    const other = personByHandle(sel.dm_with);
                    if (other) setProfileId(other.id);
                  }}
                  className="flex min-w-0 items-center gap-2.5 rounded-md px-1.5 py-1 -mx-1.5 transition-colors hover:bg-accent"
                  title="View profile"
                >
                  <PersonAvatar
                    name={personByHandle(sel.dm_with)?.display_name ?? sel.dm_with ?? "?"}
                    handle={sel.dm_with ?? "?"}
                    size="sm"
                  />
                  <h2 className="truncate font-semibold">{headerTitle}</h2>
                </button>
              ) : (
                <>
                  <Hash className="size-5 text-muted-foreground" />
                  <h2 className="truncate font-semibold">{headerTitle}</h2>
                </>
              )}

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
          <div data-testid="message-list" className="flex flex-col gap-5 px-3 py-6 md:px-5">
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
                  <button
                    onClick={() => sender && setProfileId(sender.id)}
                    disabled={!sender}
                    className="h-fit shrink-0 rounded-md transition-opacity hover:opacity-80 disabled:cursor-default"
                    title={sender ? `View @${sender.handle}` : undefined}
                  >
                    <PersonAvatar
                      name={sender?.display_name ?? lead.sender_handle}
                      handle={lead.sender_handle}
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <button
                        data-testid="message-sender"
                        onClick={() => sender && setProfileId(sender.id)}
                        disabled={!sender}
                        className="font-semibold hover:underline disabled:no-underline"
                      >
                        {sender?.display_name ?? lead.sender_handle}
                      </button>
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
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground md:px-5"
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

        {/* Pending tool confirmations for this channel (always_ask agents) */}
        {selected && confirms.filter((c) => c.channelId === selected).length > 0 && (
          <div className="mx-3 mb-1 space-y-2 md:mx-5">
            {confirms
              .filter((c) => c.channelId === selected)
              .map((c) => (
                <ConfirmCard key={c.confirmId} c={c} onDecide={decideConfirm} />
              ))}
          </div>
        )}

        {/* Notice */}
        {notice && (
          <div
            data-testid="send-notice"
            className="mx-3 mb-1 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive md:mx-5"
          >
            {notice}
          </div>
        )}

        {/* Composer */}
        <div className="px-3 pb-3 pt-1 md:px-5 md:pb-5">
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
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Model</Label>
                <SelectMenu
                  value={agModel}
                  onChange={setAgModel}
                  options={MODEL_OPTIONS}
                  testId="agent-model"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Tool permissions</Label>
                <SelectMenu
                  value={agMode}
                  onChange={setAgMode}
                  options={SDK_MODE_OPTIONS}
                  testId="agent-mode"
                />
              </div>
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

      {/* Viewing another participant: human = read-only alias; agent = editable config */}
      {profilePerson && (
        <ParticipantProfileDialog
          key={profilePerson.id}
          person={profilePerson}
          isSelf={profilePerson.id === participantId}
          onClose={() => setProfileId(null)}
          onSaved={(u) =>
            setPeople((ps) => ps.map((p) => (p.id === u.id ? { ...p, ...u } : p)))
          }
          onOpenActivity={() => {
            openActivity(profilePerson.id);
            setProfileId(null);
          }}
        />
      )}

      {/* Live Claude-Code-style transcript for an sdk agent */}
      {activityAgent && (
        <AgentActivity
          key={activityAgent.id}
          agent={activityAgent}
          events={activityEvents}
          onClose={() => {
            setActivityId(null);
            setActivityEvents([]);
          }}
          onSteer={steerAgent}
        />
      )}
    </div>
  );
}

/* ----------------------------- small pieces ----------------------------- */

// A shadcn-styled single-select built on the DropdownMenu primitive (portal=false so it
// works inside dialogs). Shows the current option's label; lists options with an optional hint.
function SelectMenu({
  value,
  onChange,
  options,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; label: string; hint?: string }[];
  testId?: string;
}) {
  const current = options.find((o) => o.id === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" data-testid={testId} className="w-full justify-between font-normal">
          <span className="truncate">{current?.label}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        portal={false}
        align="start"
        className="w-[var(--radix-dropdown-menu-trigger-width)]"
      >
        {options.map((o) => (
          <DropdownMenuItem
            key={o.id}
            data-testid={testId ? `${testId}-option` : undefined}
            onClick={() => onChange(o.id)}
            className="flex items-center justify-between gap-3"
          >
            <span className="flex flex-col">
              <span>{o.label}</span>
              {o.hint && <span className="text-xs text-muted-foreground">{o.hint}</span>}
            </span>
            {o.id === value && <Check className="size-4 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Slack-style profile for viewing another participant. Humans are read-only (just their alias
// for now). Agents expose an editable config: display name + tool-permission mode (applied live),
// model (applied at the next turn), and an Activity view.
// (The current user's own settings — email, GitHub, sign out — live at the /settings route.)
function ParticipantProfileDialog({
  person,
  isSelf,
  onClose,
  onSaved,
  onOpenActivity,
}: {
  person: Participant;
  isSelf: boolean;
  onClose: () => void;
  onSaved: (p: Participant) => void;
  onOpenActivity: () => void;
}) {
  const isAgent = person.kind === "agent";
  const [name, setName] = useState(person.display_name);
  const [mode, setMode] = useState(person.mode ?? "default");
  const [model, setModel] = useState(person.model ?? MODEL_OPTIONS[0].id);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  const dirty =
    name.trim() !== person.display_name ||
    mode !== (person.mode ?? "default") ||
    model !== (person.model ?? MODEL_OPTIONS[0].id);

  async function save() {
    if (!dirty || saving || !name.trim()) return;
    setSaving(true);
    setErr("");
    try {
      const patch: { displayName?: string; mode?: string; model?: string } = {
        displayName: name.trim(),
        mode,
        model,
      };
      const updated = await updateAgent(person.id, patch);
      onSaved(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="profile-dialog" className="sm:max-w-md">
        <DialogHeader className="sr-only">
          <DialogTitle>{person.display_name}'s profile</DialogTitle>
        </DialogHeader>
        {/* Identity header */}
        <div className="flex items-center gap-4">
          <Avatar className="size-16 rounded-xl">
            <AvatarFallback className={cn(avatarClass(person.handle), "rounded-xl text-xl")}>
              {initials(person.display_name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-bold">{person.display_name}</h2>
              {isAgent && (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  <Sparkles className="size-2.5" /> agent
                </span>
              )}
              {isSelf && <span className="text-xs text-muted-foreground">(you)</span>}
            </div>
            <div className="truncate text-sm text-muted-foreground">@{person.handle}</div>
          </div>
        </div>

        {isAgent ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="profile-name">Display name</Label>
              <Input
                id="profile-name"
                data-testid="profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Tool permissions</Label>
              <SelectMenu
                value={mode}
                onChange={setMode}
                options={SDK_MODE_OPTIONS}
                testId="agent-mode-select"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Model</Label>
              <SelectMenu
                value={model}
                onChange={setModel}
                options={MODEL_OPTIONS}
                testId="agent-model-select"
              />
              <p className="text-[11px] leading-tight text-muted-foreground">
                Applies at the agent's next turn.
              </p>
            </div>
            {person.repo && (
              <div className="min-w-0 space-y-0.5 rounded-lg border bg-muted/30 p-3">
                <div className="text-xs font-medium text-muted-foreground">Repository</div>
                <a
                  href={`https://github.com/${person.repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 truncate text-sm text-primary hover:underline"
                >
                  <GitBranch className="size-3.5 shrink-0" />
                  <span className="truncate">{person.repo}</span>
                </a>
              </div>
            )}
            <Button
              variant="outline"
              data-testid="activity-open"
              onClick={onOpenActivity}
              className="w-full justify-start gap-2 text-muted-foreground"
            >
              <Activity className="size-4" />
              View activity
            </Button>
            {err && <p className="text-sm text-destructive">{err}</p>}
          </div>
        ) : (
          <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
            {isSelf
              ? "This is how you appear to everyone in the workspace."
              : `${person.display_name} is a member of the workspace.`}
          </div>
        )}

        {isAgent && (
          <DialogFooter>
            {saved && (
              <span className="mr-auto flex items-center gap-1 text-sm text-emerald-600">
                <Check className="size-4" /> Saved
              </span>
            )}
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button
              data-testid="profile-save"
              onClick={save}
              disabled={!dirty || saving || !name.trim()}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// A pending tool-call confirmation card (always_ask agents). Approve/deny buttons resolve it.
function ConfirmCard({
  c,
  onDecide,
}: {
  c: ToolConfirm;
  onDecide: (c: ToolConfirm, d: "allow" | "deny") => void;
}) {
  const summary =
    typeof c.input === "string" ? c.input : JSON.stringify(c.input, null, 2);
  return (
    <div
      data-testid="tool-confirm-card"
      className="rounded-xl border border-amber-300/60 bg-amber-50/60 p-3 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/5"
    >
      <div className="flex items-start gap-2.5">
        <ShieldQuestion className="mt-0.5 size-5 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <div className="text-sm">
            <span className="font-semibold">{c.agentName}</span> wants to run{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{c.tool}</code>
          </div>
          {summary && summary !== "{}" && (
            <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg border bg-background/70 p-2 text-[11px] leading-relaxed">
              {summary}
            </pre>
          )}
          <div className="mt-2.5 flex gap-2">
            <Button
              size="sm"
              data-testid="tool-confirm-allow"
              onClick={() => onDecide(c, "allow")}
              className="h-8"
            >
              <Check className="size-4" /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="tool-confirm-deny"
              onClick={() => onDecide(c, "deny")}
              className="h-8"
            >
              <X className="size-4" /> Deny
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

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
  unread,
  badgeCount,
  badgeMention,
}: {
  testId: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
  working?: boolean;
  title?: string;
  unread?: boolean; // has unread messages -> bold + brighter (Slack)
  badgeCount?: number; // when > 0, show a count pill (DMs + mention-containing unreads)
  badgeMention?: boolean; // the unread includes a mention of me (badge is always shown for these)
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
          : unread
            ? "font-semibold text-sidebar-foreground hover:bg-sidebar-accent/60"
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
      {(badgeCount ?? 0) > 0 && (
        <span
          data-testid="unread-badge"
          data-mention={badgeMention ? "true" : undefined}
          className="ml-1 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground"
        >
          {(badgeCount ?? 0) > 99 ? "99+" : badgeCount}
        </span>
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
