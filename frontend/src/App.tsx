import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  listPendingConfirms,
  listDeliverables,
  setDevParticipantId,
  getThread,
  markThreadRead,
  listUnreadThreads,
  getChannelTurnChips,
  type AgentEvent,
  type Channel,
  type Deliverable,
  type Message,
  type Participant,
  type SearchResult,
  type UnreadThread,
  type Membership,
} from "./api";
import {
  mergeById,
  newId,
  type ToolConfirm,
} from "./lib/chat";
import { notify, setAppBadge } from "./lib/notifications";
import { SignIn } from "./SignIn";
import { SettingsPanel } from "./Settings";
import { Scheduled } from "./Scheduled";
import { Approvals } from "./Approvals";
import { DeliverablesView } from "./Deliverables";
import { AgentsHome } from "./AgentsHome";
import { SearchDialog } from "./SearchDialog";
import { navigate, usePath } from "./route";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DmActivityView } from "./components/chat/DmActivityView";
import { AgentActivityPanel } from "./components/chat/AgentActivityPanel";
import { ChannelActivity } from "./components/chat/ChannelActivity";
import { ChannelRoster } from "./components/chat/ChannelRoster";
import { AgentCardProvider } from "./components/chat/AgentHoverCard";
import {
  ResizeHandle,
  useMediaQuery,
  usePersistedWidth,
  LEFT_WIDTH,
  RIGHT_WIDTH,
} from "./components/chat/layout";
import { ParticipantProfilePanel, ConfirmCard } from "./components/chat/panels";
import { AddAgentDialog } from "./components/chat/AddAgentDialog";
import { Composer } from "./components/chat/Composer";
import { ChannelHeader } from "./components/chat/ChannelHeader";
import { MessageList } from "./components/chat/MessageList";
import { Sidebar } from "./components/chat/Sidebar";
import { ThreadPanel } from "./components/chat/ThreadPanel";
import { NewChannelDialog } from "./components/chat/NewChannelDialog";
import { MembersDialog } from "./components/chat/MembersDialog";
import { DeleteChannelDialog } from "./components/chat/DeleteChannelDialog";
import { InviteDialog } from "./components/chat/InviteDialog";
import { useChatSocket } from "./ws/useChatSocket";
import { useLiveTurns, type TurnChipData, type QueuedTurn } from "./ws/useLiveTurns";



export function App({
  authParticipantId,
  workspaceId,
  getWsToken,
  me: meProp,
  memberships,
  onSwitchWorkspace,
  onCreateWorkspace,
  onSignOut,
}: {
  authParticipantId?: string; // from Firebase onboarding; overrides the ?as= dev path
  workspaceId?: string; // active workspace (Firebase mode); scopes the WS handshake
  getWsToken?: () => Promise<string | null>; // fresh ID token for the WS handshake
  me?: Participant; // current user (Firebase mode)
  memberships?: Membership[]; // all workspaces this account belongs to (for the switcher)
  onSwitchWorkspace?: (workspaceId: string) => void;
  onCreateWorkspace?: () => void;
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
  // Invite-people dialog (admins only, Firebase mode)
  const [showInvite, setShowInvite] = useState(false);
  // Pending tool-confirmation cards (always_ask agents), keyed by confirmId.
  const [confirms, setConfirms] = useState<ToolConfirm[]>([]);
  // The deliverables feed (newest first): first page fetched on load, live rows appended via WS.
  const [deliverables, setDeliverables] = useState<Deliverable[]>([]);
  const [delivLoading, setDelivLoading] = useState(true);
  const [delivHasMore, setDelivHasMore] = useState(false);
  // ⌘K search palette.
  const [searchOpen, setSearchOpen] = useState(false);
  // Jump target from search / the deliverables feed: MessageList scrolls it into view with a
  // flash once the message renders, then clears it via onJumpDone.
  const [jumpToId, setJumpToId] = useState<string | null>(null);
  // Bounded always-on buffer of each agent's current turn (ambient activity surfaces), plus the
  // turn/queued state behind the trigger-message chips (turnChipsRef/queuedRef — durable across
  // reload via hydrateChannel). liveVersion is a throttled re-render tick; the live-turn-derived
  // useMemos below depend on it.
  const { liveTurnsRef, turnChipsRef, queuedRef, liveVersion, ingestLiveEvent, ingestQueued, hydrateChannel } =
    useLiveTurns();

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
  // Channel agent roster (right-panel view; the header 🤖 button toggles it).
  const [rosterOpen, setRosterOpen] = useState(false);
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
  // The Scheduled view is URL-routed (/scheduled) so it stays deep-linkable, but renders inside
  // this layout (sidebars intact) as a main-column view rather than a standalone page. Only in
  // Firebase mode (workspaceId set): the page is workspace-scoped and uses the auth context.
  const path = usePath();
  const scheduledOpen = path === "/scheduled" && !!workspaceId;
  // The other main-column views (deep-linkable like Scheduled, but not workspace-gated — they
  // work in dev mode too).
  const approvalsOpen = path === "/approvals";
  const deliverablesOpen = path === "/deliverables";
  const agentsOpen = path === "/agents";
  const overlayViewOpen = scheduledOpen || approvalsOpen || deliverablesOpen || agentsOpen;
  // Reading "am I on an overlay view" from long-lived callbacks without re-binding them.
  const overlayViewRef = useRef(false);
  overlayViewRef.current = overlayViewOpen;
  // Leave any overlay view and land back in the chat column.
  const goToChat = useCallback(() => {
    if (overlayViewRef.current) navigate("/");
  }, []);
  // Activity view: the sdk agent whose transcript is open, plus a live event buffer for it.
  // We only buffer while a view is open (activityIdRef gates the WS handler), so idle agents
  // don't accumulate unbounded memory. `activityMode` picks how it's rendered: "modal" for the
  // full-screen dialog (opened from the profile panel), "inline" for the DM header's
  // "View activity" toggle, which swaps the DM's message list for the same transcript in place.
  const [activityId, setActivityId] = useState<string | null>(null);
  // "panel": the right-panel activity+steer view (the primary surface). "inline": the DM header's
  // "View activity" toggle (swaps the DM message list). No modal — activity lives in the sidebar.
  const [activityMode, setActivityMode] = useState<"panel" | "inline">("panel");
  const [activityEvents, setActivityEvents] = useState<AgentEvent[]>([]);
  // When set, the activity view opens scrolled to this turn ("view the work behind this").
  const [activityFocusTurn, setActivityFocusTurn] = useState<string | null>(null);
  // Whether the activity panel was opened from the channel roster — drives the ← back arrow.
  const [activityFromRoster, setActivityFromRoster] = useState(false);
  const activityIdRef = useRef<string | null>(null);
  activityIdRef.current = activityId;
  const activityModeRef = useRef<"panel" | "inline">("panel");
  activityModeRef.current = activityMode;
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  // Live channel list for the WS notification decision (is this a DM? what's it called?)
  // without re-binding the socket handlers.
  const channelsRef = useRef<Channel[]>([]);
  channelsRef.current = channels;
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

  // Rebuild pending approvals from the backend (load + every WS reconnect — a confirm that
  // arrived while disconnected never fanned out to this socket).
  const refreshConfirms = useCallback(() => {
    listPendingConfirms()
      .then((rows) => setConfirms(rows.map((r) => ({ ...r }))))
      .catch(() => {});
  }, []);

  // First page of the deliverables feed; older pages via loadMoreDeliverables.
  function reloadDeliverables() {
    setDelivLoading(true);
    listDeliverables({ limit: 50 })
      .then((ds) => {
        setDeliverables(ds);
        setDelivHasMore(ds.length >= 50);
      })
      .catch(() => {})
      .finally(() => setDelivLoading(false));
  }
  async function loadMoreDeliverables() {
    if (!deliverables.length) return;
    const before = deliverables[deliverables.length - 1].id;
    const page = await listDeliverables({ before, limit: 50 }).catch(() => [] as Deliverable[]);
    setDeliverables((ds) => {
      const seen = new Set(ds.map((d) => d.id));
      return [...ds, ...page.filter((d) => !seen.has(d.id))];
    });
    setDelivHasMore(page.length >= 50);
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

  // Channels this participant belongs to + everyone (for the member picker), plus the pending
  // approvals and the deliverables feed's first page.
  useEffect(() => {
    if (!participantId) return;
    reloadChannels();
    listParticipants().then(setPeople).catch(() => {});
    refreshThreads();
    refreshConfirms();
    reloadDeliverables();
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
    // Leaving the DM whose activity was open inline closes that view too — it's specific to
    // that conversation, not a standing app mode.
    if (activityModeRef.current === "inline") setActivityId(null);
    if (!selected) return;
    getMessages(selected).then(setMessages);
    markRead(selected);
    // Hydrate this channel's trigger-message chips (recent turns + still-queued dispatches) so
    // they survive a reload — live WS state (turnChipsRef/queuedRef) always wins over this.
    getChannelTurnChips(selected)
      .then(({ turns, queued }) => hydrateChannel(selected, turns, queued))
      .catch(() => {});
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

  // ⌘K / Ctrl+K: the search palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Tab badge: everything that's directly for me — DM unreads, mention-flagged channel unreads,
  // unread thread replies, and approvals waiting on a decision.
  useEffect(() => {
    const direct = channels.reduce(
      (n, c) =>
        n + (c.kind === "dm" || c.has_mention ? c.unread_count ?? 0 : 0),
      0,
    );
    const threadUnread = unreadThreads.reduce((n, t) => n + t.unread_count, 0);
    setAppBadge(direct + threadUnread + confirms.length);
  }, [channels, unreadThreads, confirms.length]);

  // Desktop ping for an incoming message: DMs and mentions of me, when I'm not looking at that
  // conversation. Clicking focuses the tab and opens it. (lib/notifications gates on permission,
  // the user's preference, and tab focus.)
  const onNotifiableMessage = useCallback(
    (m: Message, isOpen: boolean) => {
      if (isOpen && focusedRef.current) return;
      const ch = channelsRef.current.find((c) => c.id === m.channel_id);
      const isDm = ch?.kind === "dm";
      const mentionsMe = (m.mentions ?? []).some((x) => x.id === participantId);
      if (!isDm && !mentionsMe) return;
      notify({
        title: isDm ? `@${m.sender_handle}` : `@${m.sender_handle} in #${ch?.name ?? "channel"}`,
        body: m.body || "Sent an attachment",
        tag: m.channel_id, // one notification per conversation, newest wins
        onClick: () => {
          goToChat();
          setSelected(m.channel_id);
        },
      });
    },
    [participantId, goToChat],
  );

  // Desktop ping for a tool confirmation: an agent is blocked until someone decides.
  const onConfirmRequested = useCallback((c: ToolConfirm) => {
    notify({
      title: "Approval needed",
      body: `${c.agentName} wants to run ${c.tool}`,
      tag: c.confirmId,
      onClick: () => navigate("/approvals"),
    });
  }, []);

  // One auto-reconnecting WebSocket owning the ServerEvent dispatch (see useChatSocket). Returns
  // the socket ref for posting frames (messages, thread replies, steering).
  const wsRef = useChatSocket({
    participantId,
    getWsToken,
    workspaceId,
    selectedRef,
    focusedRef,
    activityIdRef,
    setChannels,
    setPeople,
    setMessages,
    setMembers,
    setSelected,
    setConfirms,
    setActivityEvents,
    setDeliverables,
    setProfileId,
    setNotice,
    markRead,
    refreshThreads,
    reloadChannels,
    ingestLiveEvent,
    ingestQueued,
    onNotifiableMessage,
    onConfirmRequested,
    onConnected: refreshConfirms,
  });

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
    setRosterOpen(false);
    setActivityId(null);
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
    setRosterOpen(false);
    setActivityId(null);
    setDrawerOpen(false);
  }
  function openSettingsPanel() {
    setSettingsPanelOpen(true);
    setProfileId(null);
    setThreadRootId(null);
    setThreadsListOpen(false);
    setRosterOpen(false);
    setActivityId(null);
    setDrawerOpen(false);
  }
  // Toggle the channel agent roster in the right panel (header 🤖 button).
  function toggleRoster() {
    if (rosterOpen) {
      setRosterOpen(false);
      return;
    }
    setRosterOpen(true);
    setProfileId(null);
    setSettingsPanelOpen(false);
    setThreadRootId(null);
    setThreadsListOpen(false);
    setActivityId(null);
    setDrawerOpen(false);
  }
  // Open the Threads list in the right panel (takes over from a profile/settings/open-thread view).
  function openThreadsList() {
    setProfileId(null);
    setSettingsPanelOpen(false);
    setThreadRootId(null);
    setThreadsListOpen(true);
    setRosterOpen(false);
    setActivityId(null);
    refreshThreads();
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

  // Open an sdk agent's Activity+steer view in the RIGHT PANEL (from a hover card, the roster,
  // the profile panel, the agents overview, or a message's "view work"). Takes over the panel
  // from any other view. Reset the live buffer so it only holds frames that arrive while open
  // (history is fetched inside the transcript). `fromRoster` shows a ← back-to-roster arrow.
  function openActivity(
    agentId: string,
    focusTurnId: string | null = null,
    fromRoster = false,
  ) {
    setActivityEvents([]);
    setActivityMode("panel");
    setActivityFocusTurn(focusTurnId);
    setActivityFromRoster(fromRoster);
    setActivityId(agentId);
    // Take over the right panel.
    setProfileId(null);
    setSettingsPanelOpen(false);
    setThreadRootId(null);
    setThreadsListOpen(false);
    setRosterOpen(false);
    setDrawerOpen(false);
  }
  // Close the activity panel entirely (the X).
  function closeActivityPanel() {
    setActivityId(null);
    setActivityEvents([]);
    setActivityFocusTurn(null);
    setActivityFromRoster(false);
  }
  // The ← back arrow (shown only when opened from the roster): return to the roster list.
  function backToRoster() {
    closeActivityPanel();
    setRosterOpen(true);
  }

  // "View the work behind this message": open the sender agent's Activity focused on the turn
  // that produced it.
  function openTurnForMessage(m: Message) {
    const sender = people.find((p) => p.handle === m.sender_handle);
    if (!sender || !m.turn_id) return;
    openActivity(sender.id, m.turn_id);
  }

  // Open a turn (a trigger-message chip / roster row) in the Activity view, focused on it.
  function openLiveTurn(turn: TurnChipData) {
    openActivity(turn.agentId, turn.turnId);
  }

  // Jump to a message (search hit / deliverable): land in its channel, open its thread if it
  // was a pure thread reply, and let MessageList scroll + flash it once rendered.
  function jumpToMessage(channelId: string, messageId: string, threadRootId?: string | null) {
    goToChat();
    if (channelId !== selectedRef.current) setSelected(channelId);
    if (threadRootId) {
      // A pure thread reply doesn't render in the timeline — open its thread instead. Seed the
      // messages so the pane isn't blank while the channel history loads.
      getThread(channelId, threadRootId)
        .then((msgs) => setMessages((prev) => mergeById(prev, msgs)))
        .catch(() => {});
      openThread(threadRootId, channelId);
    } else {
      setJumpToId(messageId);
    }
    setDrawerOpen(false);
  }

  function jumpToSearchResult(r: SearchResult) {
    jumpToMessage(r.channel_id, r.message_id, r.thread_root_id);
  }

  // The DM header's "View activity"/"View chat" toggle: swaps the message list for the same
  // live transcript, in place, instead of a dialog. Toggling off just clears activityId, same
  // as closing the modal.
  function toggleInlineActivity(agentId: string) {
    if (activityId === agentId && activityMode === "inline") {
      setActivityId(null);
      return;
    }
    setActivityEvents([]);
    setActivityMode("inline");
    setActivityId(agentId);
  }

  // "Steer" an agent from the Activity panel footer: open/find the DM and post a normal message,
  // which flows through the inbox to the agent's next turn (same path as the composer). Quiet by
  // design — the DM shows up in the sidebar but selection stays put, so you keep watching the
  // transcript in the panel instead of being yanked into the DM (the whole point of steering
  // from the sidebar).
  async function steerAgent(agent: Participant, body: string) {
    if (!participantId) return;
    const { id } = await createDm(participantId, agent.id);
    reloadChannels(); // surface the DM in the sidebar WITHOUT stealing the current selection
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
  const peopleById = new Map(people.map((p) => [p.id, p]));
  // Agents working/waking in the currently-open channel (drives the header banner). Read status
  // from the live `people` map rather than the `members` roster snapshot so it stays current.
  const busyMembers = members
    .filter((m) => m.kind === "agent")
    .map((m) => peopleById.get(m.id) ?? m)
    .filter((m) => m.status === "working" || m.status === "waking");
  // This channel's agent members (roster panel + header 🤖 count), status-refreshed from `people`.
  const channelAgents = members
    .filter((m) => m.kind === "agent")
    .map((m) => peopleById.get(m.id) ?? m);

  // Live-turn-derived views (recompute on liveVersion, which throttles the event stream):
  //   - workingChannelIds: channels with a turn currently running (sidebar dot + header pulse).
  const workingChannelIds = useMemo(() => {
    const working = new Set<string>();
    for (const turn of liveTurnsRef.current.values()) {
      if (!turn.done && turn.context?.channelId) working.add(turn.context.channelId);
    }
    return working;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveVersion]);
  // Turn/queued chips anchored to a message, keyed by the triggering message id — durable across
  // reload (turnChipsRef/queuedRef are seeded from the backend on channel open, see the
  // hydrateChannel effect below) and not filtered by channel: a message id belongs to exactly
  // one channel, so a chip only ever gets looked up if that message is actually rendered here.
  const { turnsByMessage, queuedByMessage } = useMemo(() => {
    const byMessage = new Map<string, TurnChipData[]>();
    for (const chip of turnChipsRef.current.values()) {
      for (const mid of chip.messageIds) {
        const arr = byMessage.get(mid) ?? [];
        arr.push(chip);
        byMessage.set(mid, arr);
      }
    }
    const byQueuedMessage = new Map<string, QueuedTurn[]>();
    for (const q of queuedRef.current.values()) {
      const arr = byQueuedMessage.get(q.messageId) ?? [];
      arr.push(q);
      byQueuedMessage.set(q.messageId, arr);
    }
    return { turnsByMessage: byMessage, queuedByMessage: byQueuedMessage };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveVersion]);
  const channelAgentsActive = channelAgents.some((a) => a.status === "working");
  const profilePerson = profileId
    ? people.find((p) => p.id === profileId) ?? (me?.id === profileId ? me : undefined)
    : undefined;
  const activityAgent = activityId ? people.find((p) => p.id === activityId) : undefined;
  // The other side of the open DM, when it's an sdk agent — drives the header's activity toggle.
  const dmAgent =
    sel?.kind === "dm" ? personByHandle(sel.dm_with) : undefined;
  const dmAgentIsSdk = dmAgent?.kind === "agent" && dmAgent?.runtime === "sdk" ? dmAgent : undefined;
  const inlineActivityOpen =
    activityMode === "inline" && !!dmAgentIsSdk && activityId === dmAgentIsSdk.id;

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

  // Activity+steer as a right-panel view (the primary Activity surface — no modal). Gated on an
  // sdk agent target and panel mode (the DM inline toggle uses "inline", handled separately).
  const activityPanelAgent =
    activityMode === "panel" && activityAgent?.runtime === "sdk" ? activityAgent : undefined;

  // The right panel hosts one view at a time. Precedence: activity/profile/settings (explicit
  // opens) win over threads/roster; each opener already cleared the others.
  const rightMode: "activity" | "profile" | "settings" | "threads" | "roster" | null =
    activityPanelAgent
      ? "activity"
      : profilePerson
        ? "profile"
        : settingsPanelOpen
          ? "settings"
          : threadPanelOpen
            ? "threads"
            : rosterOpen && sel?.kind !== "dm"
              ? "roster"
              : null;
  const rightOpen = rightMode !== null;
  const closeRightPanel = () => {
    setProfileId(null);
    setSettingsPanelOpen(false);
    setThreadRootId(null);
    setThreadsListOpen(false);
    setRosterOpen(false);
    closeActivityPanel();
  };

  // The agent hover-card context: any @mention / sender / roster entry renders a card knowing
  // only an agent id. `version` (liveVersion) makes open cards recompute their live "now" line.
  const agentCardValue = {
    getAgent: (id: string) => peopleById.get(id),
    getLiveTurn: (id: string) => liveTurnsRef.current.get(id),
    onMessage: (id: string) => {
      goToChat();
      openDm(id);
    },
    onOpenActivity: (id: string) => openActivity(id),
    onOpenProfile: (id: string) => {
      goToChat();
      openProfilePanel(id);
    },
    version: liveVersion,
  };

  return (
    <AgentCardProvider value={agentCardValue}>
    <div className="relative flex h-screen-dvh w-full overflow-hidden bg-background text-foreground">
      {/* Mobile backdrop: tapping it closes the off-canvas drawer. Desktop (md+) never shows it. */}
      {drawerOpen && (
        <div
          data-testid="sidebar-backdrop"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      )}

      {/* ---------- Sidebar ---------- */}
      <Sidebar
        rooms={rooms}
        dms={dms}
        others={others}
        selected={selected}
        me={me}
        threadsListOpen={threadsListOpen}
        totalThreadUnread={totalThreadUnread}
        isDesktop={isDesktop}
        sidebarOpen={sidebarOpen}
        drawerOpen={drawerOpen}
        resizing={resizing}
        leftWidth={left.width}
        personByHandle={personByHandle}
        dmChannelWith={dmChannelWith}
        onSelectChannel={(id) => {
          goToChat();
          selectAndClose(id);
        }}
        onOpenDm={(id) => {
          goToChat();
          openDm(id);
        }}
        onOpenThreads={() => {
          goToChat();
          openThreadsList();
        }}
        onOpenScheduled={() => navigate("/scheduled")}
        scheduledActive={scheduledOpen}
        onOpenAgents={() => navigate("/agents")}
        agentsActive={agentsOpen}
        onOpenApprovals={() => navigate("/approvals")}
        approvalsActive={approvalsOpen}
        approvalsCount={confirms.length}
        onOpenDeliverables={() => navigate("/deliverables")}
        deliverablesActive={deliverablesOpen}
        onOpenSearch={() => {
          setSearchOpen(true);
          setDrawerOpen(false);
        }}
        workingChannelIds={workingChannelIds}
        onNewChannel={() => setShowNew(true)}
        onAddAgent={() => setShowAddAgent(true)}
        onCollapse={() => {
          setSidebarOpen(false); // desktop: collapse
          setDrawerOpen(false); // mobile: close the off-canvas drawer
        }}
        onOpenProfile={(id) => {
          goToChat();
          openProfilePanel(id);
        }}
        onOpenSettings={() => {
          goToChat();
          openSettingsPanel();
        }}
        onSignOut={signOut}
        workspaceId={workspaceId}
        memberships={memberships}
        onSwitchWorkspace={onSwitchWorkspace}
        onCreateWorkspace={onCreateWorkspace}
        onInvitePeople={() => setShowInvite(true)}
      />

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
      {scheduledOpen ? (
        <Scheduled
          workspaceId={workspaceId!}
          sidebarOpen={sidebarOpen}
          onOpenDrawer={() => setDrawerOpen(true)}
          onExpandSidebar={() => setSidebarOpen(true)}
        />
      ) : approvalsOpen ? (
        <Approvals
          confirms={confirms}
          channels={channels}
          sidebarOpen={sidebarOpen}
          onOpenDrawer={() => setDrawerOpen(true)}
          onExpandSidebar={() => setSidebarOpen(true)}
          onDecide={decideConfirm}
          onJumpToChannel={(channelId) => {
            goToChat();
            selectAndClose(channelId);
          }}
        />
      ) : deliverablesOpen ? (
        <DeliverablesView
          deliverables={deliverables}
          loading={delivLoading}
          hasMore={delivHasMore}
          onLoadMore={loadMoreDeliverables}
          sidebarOpen={sidebarOpen}
          onOpenDrawer={() => setDrawerOpen(true)}
          onExpandSidebar={() => setSidebarOpen(true)}
          onJumpToMessage={(channelId, messageId) => jumpToMessage(channelId, messageId)}
        />
      ) : agentsOpen || !sel ? (
        // Mission control — also the landing view when no conversation is open.
        <AgentsHome
          agents={others.filter((p) => p.kind === "agent")}
          liveTurns={liveTurnsRef.current}
          confirms={confirms}
          deliverables={deliverables}
          sidebarOpen={sidebarOpen}
          onOpenDrawer={() => setDrawerOpen(true)}
          onExpandSidebar={() => setSidebarOpen(true)}
          onOpenDm={(id) => {
            goToChat();
            openDm(id);
          }}
          onOpenActivity={openActivity}
          onOpenProfile={(id) => {
            goToChat();
            openProfilePanel(id);
          }}
          onOpenApprovals={() => navigate("/approvals")}
          onAddAgent={() => setShowAddAgent(true)}
        />
      ) : (
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        {/* Channel header */}
        <ChannelHeader
          channel={sel}
          headerTitle={headerTitle}
          sidebarOpen={sidebarOpen}
          memberCount={members.length}
          agentCount={channelAgents.length}
          agentsActive={channelAgentsActive}
          rosterOpen={rosterOpen && sel?.kind !== "dm"}
          personByHandle={personByHandle}
          dmAgent={dmAgentIsSdk}
          activityOpen={inlineActivityOpen}
          onOpenDrawer={() => setDrawerOpen(true)}
          onExpandSidebar={() => setSidebarOpen(true)}
          onOpenProfile={openProfilePanel}
          onOpenMembers={() => setShowMembers(true)}
          onOpenRoster={toggleRoster}
          onDeleteChannel={() => setShowDeleteConfirm(true)}
          onToggleActivity={() => dmAgentIsSdk && toggleInlineActivity(dmAgentIsSdk.id)}
        />

        {/* Messages, or — in an agent DM with "View activity" toggled on — that agent's live
            transcript in place of the message list. */}
        {inlineActivityOpen && dmAgentIsSdk ? (
          <DmActivityView agent={dmAgentIsSdk} events={activityEvents} />
        ) : (
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
            onOpenTurn={openTurnForMessage}
            turnsByMessage={turnsByMessage}
            queuedByMessage={queuedByMessage}
            personById={(id) => peopleById.get(id)}
            onOpenLiveTurn={openLiveTurn}
            jumpToId={jumpToId}
            onJumpDone={() => setJumpToId(null)}
          />
        )}

        {/* Ambient agent activity — DMs only (a DM is single-threaded, so the strip above the
            composer is its natural home). Channels anchor live work under the triggering message
            via the trigger-message chips instead, so an agent working on something you asked in a
            DIFFERENT channel never shows up here. Hidden while the inline activity view is open. */}
        {sel?.kind === "dm" && selected && !inlineActivityOpen && (
          <ChannelActivity
            channelId={selected}
            busyAgents={busyMembers}
            liveTurns={liveTurnsRef.current}
            onOpenActivity={openActivity}
          />
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
      )}

      {/* ---------- Right panel (contextual sidebar) ----------
          Desktop (md+): in-flow, drag-resizable third column. Mobile: fixed right overlay.
          Hosts one of three views at a time — a participant profile, self settings, or the
          Threads pane (its own list / open-thread sub-modes). */}
      {/* Right panel resize divider (desktop only; sits between main and the panel). */}
      {rightOpen && !scheduledOpen && isDesktop && (
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

      {rightOpen && !scheduledOpen && (
        <aside
          data-testid="right-panel"
          style={isDesktop ? { width: right.width } : undefined}
          className={cn(
            "fixed inset-y-0 right-0 z-40 flex w-full max-w-[440px] flex-col border-l bg-background shadow-xl",
            // The 440px cap is for the mobile fixed overlay only — on desktop the panel's width is
            // fully driven by the resize handle (RIGHT_WIDTH.max is 620), so cancel the cap there
            // or dragging past 440px silently does nothing.
            "md:relative md:z-auto md:max-w-none md:shadow-none",
            !resizing && "md:transition-[width] md:duration-200 md:ease-in-out",
          )}
        >
          {/* Activity + steer view (the primary Activity surface — opened from hover cards, the
              roster, the profile, the agents overview, or a message's "view work"). */}
          {rightMode === "activity" && activityPanelAgent && (
            <AgentActivityPanel
              key={activityPanelAgent.id}
              agent={activityPanelAgent}
              events={activityEvents}
              focusTurnId={activityFocusTurn}
              onBack={activityFromRoster ? backToRoster : undefined}
              onClose={closeActivityPanel}
              onOpenProfile={openProfilePanel}
              onSteer={steerAgent}
            />
          )}

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
              rootTurns={(threadRootId && turnsByMessage.get(threadRootId)) || []}
              rootQueued={(threadRootId && queuedByMessage.get(threadRootId)) || []}
              personById={(id) => peopleById.get(id)}
              onOpenTurn={openLiveTurn}
            />
          )}

          {/* Channel agent roster: this channel's agents, active-first, with live activity.
              Card body → profile; Activity button → the activity panel (with a ← back to here). */}
          {rightMode === "roster" && sel && (
            <ChannelRoster
              channelName={sel.name}
              agents={channelAgents}
              liveTurns={liveTurnsRef.current}
              confirms={confirms}
              onClose={() => setRosterOpen(false)}
              onOpenProfile={openProfilePanel}
              onMessage={(id) => {
                goToChat();
                openDm(id);
              }}
              onOpenActivity={(id) => openActivity(id, null, true)}
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

      {workspaceId && (
        <InviteDialog open={showInvite} onOpenChange={setShowInvite} workspaceId={workspaceId} />
      )}

      {/* ⌘K search: messages (server FTS), channels, and people. */}
      <SearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        channels={channels}
        people={people}
        participantId={participantId}
        onSelectChannel={(id) => {
          goToChat();
          selectAndClose(id);
        }}
        onOpenDm={(id) => {
          goToChat();
          openDm(id);
        }}
        onJumpToMessage={jumpToSearchResult}
      />
    </div>
    </AgentCardProvider>
  );
}

/* ----------------------------- small pieces ----------------------------- */

