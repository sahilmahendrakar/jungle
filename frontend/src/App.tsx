import { useEffect, useMemo, useRef, useState } from "react";
import type { ServerEvent } from "@jungle/shared";
import {
  listChannels,
  markChannelRead,
  getMessages,
  listParticipants,
  createDm,
  listChannelMembers,
  addChannelMember,
  removeChannelMember,
  deleteChannel,
  confirmToolCall,
  setDevParticipantId,
  getThread,
  markThreadRead,
  listUnreadThreads,
  WS_BASE,
  type AgentEvent,
  type AgentStatus,
  type Channel,
  type Message,
  type Participant,
  type UnreadThread,
} from "./api";
import {
  mergeById,
  newId,
  STATUS_RANK,
  type ToolConfirm,
} from "./lib/chat";
import { SignIn } from "./SignIn";
import { firebaseEnabled } from "./firebase";
import { SettingsPanel } from "./Settings";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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
import { AgentActivity } from "./AgentActivity";
import {
  WorkingDots,
  ResizeHandle,
  useMediaQuery,
  usePersistedWidth,
  LEFT_WIDTH,
  RIGHT_WIDTH,
} from "./components/chat/layout";
import {
  ParticipantProfilePanel,
  ConfirmCard,
  SectionHeader,
  NavItem,
  PersonAvatar,
  EmptyHint,
} from "./components/chat/panels";
import { AddAgentDialog } from "./components/chat/AddAgentDialog";
import { Composer } from "./components/chat/Composer";
import { MessageList } from "./components/chat/MessageList";
import { ThreadPanel } from "./components/chat/ThreadPanel";
import { NewChannelDialog } from "./components/chat/NewChannelDialog";
import { MembersDialog } from "./components/chat/MembersDialog";
import { DeleteChannelDialog } from "./components/chat/DeleteChannelDialog";
import {
  Activity,
  Bot,
  Hash,
  LogOut,
  MessagesSquare,
  MoreVertical,
  PanelLeft,
  PanelLeftClose,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";



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
  const [notice, setNotice] = useState("");
  // New-channel dialog (the form lives inside NewChannelDialog)
  const [showNew, setShowNew] = useState(false);
  // Add-agent form
  const [showAddAgent, setShowAddAgent] = useState(false);
  // Pending tool-confirmation cards (always_ask agents), keyed by confirmId.
  const [confirms, setConfirms] = useState<ToolConfirm[]>([]);

  // Threads. The right-side panel is open when a thread is open (threadRootId) or the Threads
  // list is showing (threadsListOpen). Replies + the root are DERIVED from `messages` (the
  // client already holds the whole open channel), so there's no separate thread cache.
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [threadsListOpen, setThreadsListOpen] = useState(false);
  const [unreadThreads, setUnreadThreads] = useState<UnreadThread[]>([]);
  const threadRootIdRef = useRef<string | null>(null);
  useEffect(() => {
    threadRootIdRef.current = threadRootId;
  }, [threadRootId]);
  // Which channel the open thread belongs to (set by openThread). Lets the [selected] effect
  // close a stale panel when navigating AWAY from the thread's channel, without closing it
  // during openThreadFromList's select-then-open flow (where the target channel matches).
  const threadChannelRef = useRef<string | null>(null);
  // Channel members panel + delete (the dialogs own their transient add-query / busy state)
  const [members, setMembers] = useState<Participant[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Collapsible sidebar (persisted, desktop) + profile dialog (participant id being viewed)
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem("jungle.sidebar") !== "closed",
  );
  // Off-canvas drawer state (mobile only; independent of the desktop persisted preference).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  // Self settings live in the right panel (firebase mode); mutually exclusive with a profile.
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);

  // Drag-resizable widths for the two sidebars (desktop only). `resizing` suppresses the
  // width transition mid-drag so the panel tracks the pointer instead of easing behind it.
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const left = usePersistedWidth(LEFT_WIDTH);
  const right = usePersistedWidth(RIGHT_WIDTH);
  const [resizing, setResizing] = useState(false);
  // Activity view: the sdk agent whose transcript is open, plus a live event buffer for it.
  // We only buffer while a view is open (activityIdRef gates the WS handler), so idle agents
  // don't accumulate unbounded memory.
  const [activityId, setActivityId] = useState<string | null>(null);
  const [activityEvents, setActivityEvents] = useState<AgentEvent[]>([]);
  const activityIdRef = useRef<string | null>(null);
  activityIdRef.current = activityId;
  const wsRef = useRef<WebSocket | null>(null);
  const selectedRef = useRef<string | null>(null);
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

  // Reload my followed-threads-with-unread list (drives the Threads nav badge + list view).
  function refreshThreads() {
    listUnreadThreads().then(setUnreadThreads).catch(() => {});
  }

  function refreshMembers() {
    if (!selected) return;
    listChannelMembers(selected).then(setMembers).catch(() => {});
  }

  async function addMember(handle: string) {
    if (!selected) return;
    try {
      await addChannelMember(selected, handle);
      refreshMembers();
      reloadChannels(selected);
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    }
  }

  async function removeMember(p: Participant) {
    if (!selected) return;
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
    }
  }

  async function confirmDeleteChannel() {
    if (!selected) return;
    try {
      await deleteChannel(selected);
      setShowDeleteConfirm(false);
      setShowMembers(false);
      setSelected(null);
      reloadChannels();
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    }
  }

  // Channels this participant belongs to + everyone (for the member picker).
  useEffect(() => {
    if (!participantId) return;
    reloadChannels();
    listParticipants().then(setPeople).catch(() => {});
    refreshThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participantId]);

  // Load history when the selected channel changes, and mark it read (Slack: opening a
  // channel clears its unread state).
  useEffect(() => {
    // Navigating away from the open thread's channel closes the thread panel — left open it
    // goes stale: header shows the new conversation, body never loads, and the reply composer
    // silently no-ops (sendThreadReply guards on the derived root). Covers channel/DM clicks,
    // channel deletion (selected -> null), and the WS channel_deleted/participant_deleted paths.
    if (threadRootIdRef.current && threadChannelRef.current !== selected) {
      setThreadRootId(null);
      setThreadsListOpen(false);
    }
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
    if (!selected) {
      setMembers([]);
      return;
    }
    listChannelMembers(selected).then(setMembers).catch(() => setMembers([]));
  }, [selected]);

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
        // Typed against the shared ServerEvent union (same contract the backend emits), so each
        // branch below is checked against the real frame shape instead of an untyped any.
        const evt = JSON.parse(e.data) as ServerEvent;
        if (evt.type === "agent_status_changed") {
          setPeople((ps) => ps.map((p) => (p.id === evt.agentId ? { ...p, status: evt.status } : p)));
          return;
        }
        if (evt.type === "members_changed") {
          if (evt.channelId === selectedRef.current)
            listChannelMembers(evt.channelId).then(setMembers).catch(() => {});
          // Keep member_agent_ids fresh for the sidebar status dot even on non-open channels.
          reloadChannels();
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
        if (evt.type === "agent_context") {
          // Per-turn context-window occupancy; keeps an open profile's meter live.
          setPeople((ps) =>
            ps.map((p) =>
              p.id === evt.agentId
                ? {
                    ...p,
                    context_tokens: evt.tokens,
                    context_max_tokens: evt.maxTokens,
                    context_updated_at: new Date().toISOString(),
                  }
                : p,
            ),
          );
          return;
        }
        if (evt.type === "participant_deleted") {
          // Resolve the deleted agent's handle so we can drop its DM channel (DMs are keyed
          // by the other member's handle via dm_with), then remove the participant itself.
          setPeople((ps) => {
            const gone = ps.find((p) => p.id === evt.participantId);
            if (gone) {
              setChannels((cs) => {
                const dm = cs.find((c) => c.kind === "dm" && c.dm_with === gone.handle);
                if (dm && dm.id === selectedRef.current) setSelected(null);
                return cs.filter((c) => c.id !== dm?.id);
              });
            }
            return ps.filter((p) => p.id !== evt.participantId);
          });
          // Close the profile dialog if it was showing the deleted agent.
          setProfileId((cur) => (cur === evt.participantId ? null : cur));
          return;
        }
        if (evt.type === "agent_event") {
          // Only buffer live SDK stream messages while that agent's Activity view is open —
          // otherwise we'd grow memory for every agent forever. When closed, drop the frame;
          // the transcript backfills from the events API when reopened.
          if (evt.agentId !== activityIdRef.current) return;
          const e: AgentEvent = {
            // WS frames carry the raw event but no id (the events API assigns numeric ids on
            // reload); use a monotonic fallback so dedupe/order stay stable within the live buffer.
            id: Date.now() + Math.random(),
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
        // An incoming thread reply (not mine) may change my followed-threads-with-unread —
        // refresh the Threads badge/list regardless of which channel is open. (When the thread
        // is open, the reply also flows into `messages` below and the pane re-derives from it.)
        if (m.thread_root_id && !isMine) refreshThreads();
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
        // A pure thread reply does NOT count toward the channel badge (it has its own per-thread
        // unread); only top-level messages and replies echoed to the channel do. This is the
        // client twin of the listChannels SQL filter + the timeline bucketing — keep all three
        // in sync (see the `timeline` memo below).
        if (isMine || !(!m.thread_root_id || m.also_to_channel)) return;
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

  // Post the composer's message over WS. No optimistic echo — the message appears when it
  // round-trips back, which proves the full send -> persist -> fan-out -> render loop. Returns
  // false (and surfaces a notice) when it can't send, so the composer keeps the draft.
  function postMessage(body: string, attachmentIds: string[]): boolean {
    if (!selected) {
      setNotice("Pick or create a channel first.");
      return false;
    }
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setNotice("Connecting to the server… try again in a moment.");
      return false;
    }
    wsRef.current.send(
      JSON.stringify({
        type: "post",
        channelId: selected,
        body,
        clientMsgId: newId(),
        ...(attachmentIds.length ? { attachmentIds } : {}),
      }),
    );
    setNotice("");
    return true;
  }

  // Open a thread in the right panel (root + replies derive from loaded messages — safe today
  // because getMessages returns the whole channel with no pagination; if that ever changes,
  // route this through getThread like openThreadFromList does for a not-yet-loaded channel).
  // Opening marks it read, which clears its per-thread unread everywhere. `channelId` is the
  // thread's home channel (defaults to the open one); the [selected] effect uses it to close
  // the panel only when navigating somewhere else.
  function openThread(rootId: string, channelId: string | null = selectedRef.current) {
    threadChannelRef.current = channelId;
    // The right panel shows one thing at a time — a thread takes over from a profile/settings.
    setProfileId(null);
    setSettingsPanelOpen(false);
    setThreadsListOpen(false);
    setThreadRootId(rootId);
    markThreadRead(rootId)
      .then(() => refreshThreads())
      .catch(() => {});
  }

  // Open a thread from the Threads list — it may live in a channel that isn't currently open, so
  // select that channel first (its history load brings in the thread's messages to derive from).
  function openThreadFromList(t: UnreadThread) {
    if (t.channel_id !== selectedRef.current) {
      setSelected(t.channel_id);
      // History for the new channel loads via the [selected] effect; the panel derives once it
      // arrives. If it isn't loaded yet, seed the thread directly so the pane isn't blank.
      getThread(t.channel_id, t.root_id)
        .then((msgs) => setMessages((prev) => mergeById(prev, msgs)))
        .catch(() => {});
    }
    openThread(t.root_id, t.channel_id);
  }

  // The right panel is shared by three views — a participant profile, self settings, and the
  // threads pane. Opening any one clears the others so they never fight over the panel, and
  // closes the mobile nav drawer so the panel isn't hidden behind it.
  function openProfilePanel(id: string) {
    setProfileId(id);
    setSettingsPanelOpen(false);
    setThreadRootId(null);
    setThreadsListOpen(false);
    setDrawerOpen(false);
  }
  function openSettingsPanel() {
    setSettingsPanelOpen(true);
    setProfileId(null);
    setThreadRootId(null);
    setThreadsListOpen(false);
    setDrawerOpen(false);
  }

  // Post a reply into the open thread. Round-trips over WS like send(); it reappears in
  // `messages` (thread_root_id set) and the pane re-derives. alsoToChannel echoes it to the
  // main timeline too.
  // Post a reply into the open thread over WS. Returns false (with a notice) when it can't send,
  // so ThreadPanel keeps the draft. The reply reappears in `messages` and the pane re-derives.
  function sendThreadReply(body: string, alsoToChannel: boolean): boolean {
    if (!threadRootId || !threadRoot) return false;
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setNotice("Connecting to the server… try again in a moment.");
      return false;
    }
    wsRef.current.send(
      JSON.stringify({
        type: "post",
        channelId: threadRoot.channel_id,
        body,
        clientMsgId: newId(),
        threadRootId,
        ...(alsoToChannel ? { alsoToChannel: true } : {}),
      }),
    );
    return true;
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

  async function decideConfirm(c: ToolConfirm, decision: "allow" | "deny") {
    setConfirms((cs) => cs.filter((x) => x.confirmId !== c.confirmId)); // optimistic
    try {
      await confirmToolCall(c.confirmId, decision);
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    }
  }

  // Group consecutive messages by the same sender for a cleaner, Slack-like feed.
  // Main-timeline messages: top-level messages, plus thread replies explicitly echoed to the
  // channel ("also send to channel"). Pure thread replies live only in the thread pane. This is
  // the same predicate as the WS channel-unread guard + the listChannels SQL filter.
  const timeline = useMemo(
    () => messages.filter((m) => !m.thread_root_id || m.also_to_channel),
    [messages],
  );

  // Reply count per root, derived from the loaded channel messages (always consistent with what
  // the client holds — no reliance on the denormed root.reply_count for rendering).
  const replyCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of messages) {
      if (m.thread_root_id) counts.set(m.thread_root_id, (counts.get(m.thread_root_id) ?? 0) + 1);
    }
    return counts;
  }, [messages]);

  // Unread replies per followed thread (from the Threads endpoint), for the reply-footer badge.
  const unreadByRoot = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of unreadThreads) m.set(t.root_id, t.unread_count);
    return m;
  }, [unreadThreads]);

  // The open thread, derived from loaded messages: its root and its replies (seq order).
  const threadRoot = useMemo(
    () => (threadRootId ? messages.find((m) => m.id === threadRootId) ?? null : null),
    [messages, threadRootId],
  );
  const threadReplies = useMemo(
    () =>
      threadRootId
        ? messages
            .filter((m) => m.thread_root_id === threadRootId)
            .sort((a, b) => Number(a.seq) - Number(b.seq))
        : [],
    [messages, threadRootId],
  );

  const grouped = useMemo(() => {
    const out: { lead: Message; rest: Message[] }[] = [];
    for (const m of timeline) {
      const last = out[out.length - 1];
      if (last && last.lead.sender_id === m.sender_id) last.rest.push(m);
      else out.push({ lead: m, rest: [] });
    }
    return out;
  }, [timeline]);

  if (!participantId) return <SignIn />;

  const sel = channels.find((c) => c.id === selected);
  const others = people.filter((p) => p.id !== participantId);
  const rooms = channels.filter((c) => c.kind !== "dm");
  const dms = channels.filter((c) => c.kind === "dm");
  const dmChannelWith = (handle: string) => dms.find((c) => c.dm_with === handle);
  const personByHandle = (h?: string | null) =>
    h ? people.find((p) => p.handle === h) : undefined;
  // Per-agent status lookup + the priority rule for a channel row with several agent members.
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const rowAgentStatus = (agentIds?: string[]): AgentStatus | undefined => {
    let best: AgentStatus | undefined;
    for (const id of agentIds ?? []) {
      const s = peopleById.get(id)?.status;
      if (s && (!best || STATUS_RANK[s] < STATUS_RANK[best])) best = s;
    }
    return best;
  };
  // Agents working/waking in the currently-open channel (drives the header banner). Read status
  // from the live `people` map rather than the `members` roster snapshot so it stays current.
  const busyMembers = members
    .filter((m) => m.kind === "agent")
    .map((m) => peopleById.get(m.id) ?? m)
    .filter((m) => m.status === "working" || m.status === "waking");
  const profilePerson = profileId
    ? people.find((p) => p.id === profileId) ?? (me?.id === profileId ? me : undefined)
    : undefined;
  const activityAgent = activityId ? people.find((p) => p.id === activityId) : undefined;

  const headerTitle = sel
    ? sel.kind === "dm"
      ? `@${sel.dm_with ?? "dm"}`
      : sel.name
    : null;

  const totalThreadUnread = unreadThreads.reduce((n, t) => n + t.unread_count, 0);

  // Compact message row for the thread panel (root + replies), not sender-grouped.
  const threadPanelOpen = !!threadRootId || threadsListOpen;
  const closeThreadPanel = () => {
    setThreadRootId(null);
    setThreadsListOpen(false);
  };

  // The right panel hosts one of three views at a time. Profile/settings win over the threads
  // pane (opening either already cleared the others via the openers above).
  const rightMode: "profile" | "settings" | "threads" | null = profilePerson
    ? "profile"
    : settingsPanelOpen
      ? "settings"
      : threadPanelOpen
        ? "threads"
        : null;
  const rightOpen = rightMode !== null;
  const closeRightPanel = () => {
    setProfileId(null);
    setSettingsPanelOpen(false);
    setThreadRootId(null);
    setThreadsListOpen(false);
  };

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
        // Desktop width is driven by inline style (drag-resizable, persisted); collapsing sets
        // it to 0. Mobile keeps the fixed w-72 off-canvas drawer, so the inline style is only
        // applied at md+ (via isDesktop). The width transition is dropped mid-drag so the panel
        // tracks the pointer instead of easing behind it.
        style={isDesktop ? { width: sidebarOpen ? left.width : 0 } : undefined}
        className={cn(
          "shrink-0 overflow-hidden",
          // Mobile: off-canvas fixed drawer.
          "fixed inset-y-0 left-0 z-40 w-72 transition-transform duration-200 ease-in-out",
          drawerOpen ? "translate-x-0" : "-translate-x-full",
          // Desktop: in-flow (relative, so the resize handle anchors here) with the mobile
          // transform reset.
          "md:relative md:z-auto md:translate-x-0",
          !resizing && "md:transition-[width] md:duration-200 md:ease-in-out",
        )}
      >
        <div
          className="flex h-full w-72 flex-col bg-sidebar text-sidebar-foreground"
          style={isDesktop ? { width: left.width } : undefined}
        >
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
            {/* Threads: my followed threads with unread replies (participation-gated). */}
            <NavItem
              testId="threads-nav"
              active={threadsListOpen}
              onClick={() => {
                // Threads take over the right panel from a profile/settings view.
                setProfileId(null);
                setSettingsPanelOpen(false);
                setThreadRootId(null);
                setThreadsListOpen(true);
                refreshThreads();
                setDrawerOpen(false);
              }}
              icon={<MessagesSquare className="size-4 opacity-70" />}
              label="Threads"
              unread={totalThreadUnread > 0}
              badgeCount={totalThreadUnread}
              badgeMention={totalThreadUnread > 0}
            />

            <div className="h-3" />
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
                  status={rowAgentStatus(c.member_agent_ids)}
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
                      status={p?.kind === "agent" ? p.status : undefined}
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
                status={p.kind === "agent" ? p.status : undefined}
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
              onClick={() => (firebaseEnabled ? openSettingsPanel() : openProfilePanel(me.id))}
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

      {/* Left sidebar resize divider (desktop, only while expanded). */}
      {isDesktop && sidebarOpen && (
        <ResizeHandle
          edge="left"
          testId="sidebar-resize"
          label="Resize sidebar"
          width={left.width}
          min={LEFT_WIDTH.min}
          max={LEFT_WIDTH.max}
          onResize={left.setWidth}
          onReset={left.reset}
          onResizeStart={() => setResizing(true)}
          onResizeEnd={() => setResizing(false)}
        />
      )}

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
                    if (other) openProfilePanel(other.id);
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
        <MessageList
          grouped={grouped}
          hasChannel={!!sel}
          channelId={selected}
          headerTitle={headerTitle}
          personByHandle={personByHandle}
          onOpenProfile={openProfilePanel}
          replyCounts={replyCounts}
          unreadByRoot={unreadByRoot}
          onOpenThread={openThread}
        />

        {/* Working / waking indicator (conditionally rendered: absent when everyone's idle) */}
        {busyMembers.length > 0 && (
          <div
            data-testid="working-indicator"
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground md:px-5"
          >
            <WorkingDots />
            <span>
              <span className="font-medium text-foreground">
                {busyMembers.map((m) => `@${m.handle}`).join(", ")}
              </span>{" "}
              {busyMembers.length > 1 ? "are" : "is"}{" "}
              {busyMembers.every((m) => m.status === "waking") ? "waking up…" : "working…"}
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
        <Composer
          headerTitle={headerTitle}
          isDm={sel?.kind === "dm"}
          people={people}
          members={members}
          participantId={participantId}
          onSend={postMessage}
          onNotice={setNotice}
        />
      </main>

      {/* ---------- Right panel (contextual sidebar) ----------
          Desktop (md+): in-flow, drag-resizable third column. Mobile: fixed right overlay.
          Hosts one of three views at a time — a participant profile, self settings, or the
          Threads pane (its own list / open-thread sub-modes). */}
      {/* Right panel resize divider (desktop only; sits between main and the panel). */}
      {rightOpen && isDesktop && (
        <ResizeHandle
          edge="right"
          testId="right-panel-resize"
          label="Resize panel"
          width={right.width}
          min={RIGHT_WIDTH.min}
          max={RIGHT_WIDTH.max}
          onResize={right.setWidth}
          onReset={right.reset}
          onResizeStart={() => setResizing(true)}
          onResizeEnd={() => setResizing(false)}
        />
      )}

      {rightOpen && (
        <aside
          data-testid="right-panel"
          style={isDesktop ? { width: right.width } : undefined}
          className={cn(
            "fixed inset-y-0 right-0 z-40 flex w-full max-w-[440px] flex-col border-l bg-background shadow-xl",
            "md:relative md:z-auto md:shadow-none",
            !resizing && "md:transition-[width] md:duration-200 md:ease-in-out",
          )}
        >
          {/* Profile view (agent / human / self) */}
          {rightMode === "profile" && profilePerson && (
            <ParticipantProfilePanel
              key={profilePerson.id}
              person={profilePerson}
              isSelf={profilePerson.id === participantId}
              onClose={closeRightPanel}
              onSaved={(u) =>
                setPeople((ps) => ps.map((p) => (p.id === u.id ? { ...p, ...u } : p)))
              }
              onOpenActivity={() => openActivity(profilePerson.id)}
              onDeleted={(id) => {
                setPeople((ps) => ps.filter((p) => p.id !== id));
                closeRightPanel();
              }}
            />
          )}

          {/* Self settings view (account + GitHub); firebase mode only */}
          {rightMode === "settings" && <SettingsPanel onClose={closeRightPanel} />}

          {/* Threads view */}
          {rightMode === "threads" && (
            <ThreadPanel
              threadRootId={threadRootId}
              threadRoot={threadRoot}
              threadReplies={threadReplies}
              unreadThreads={unreadThreads}
              channel={sel}
              personByHandle={personByHandle}
              onOpenProfile={openProfilePanel}
              onClose={closeThreadPanel}
              onOpenThreadFromList={openThreadFromList}
              onSendReply={sendThreadReply}
            />
          )}
        </aside>
      )}

      {/* ---------- New channel dialog ---------- */}
      <NewChannelDialog
        open={showNew}
        onOpenChange={setShowNew}
        others={others}
        me={me}
        onCreated={(id) => reloadChannels(id)}
        onNotice={setNotice}
      />

      {/* ---------- Channel members dialog ---------- */}
      <MembersDialog
        open={showMembers}
        onOpenChange={setShowMembers}
        channelName={sel?.name}
        members={members}
        others={others}
        participantId={participantId}
        onAdd={addMember}
        onRemove={removeMember}
      />

      {/* ---------- Delete channel confirm ---------- */}
      <DeleteChannelDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        channelName={sel?.name}
        onConfirm={confirmDeleteChannel}
      />

      {/* ---------- Add agent dialog ---------- */}
      <AddAgentDialog
        open={showAddAgent}
        onOpenChange={setShowAddAgent}
        onCreated={() => listParticipants().then(setPeople).catch(() => {})}
        onNotice={setNotice}
      />

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

