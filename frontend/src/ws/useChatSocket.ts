import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ServerEvent, TurnContext } from "@jungle/shared";
import {
  WS_BASE,
  getMessages,
  listChannelMembers,
  type AgentEvent,
  type Channel,
  type Deliverable,
  type Message,
  type Participant,
} from "../api";
import { reconcileHistory, type ToolConfirm } from "../lib/chat";

// How often the client probes the server, and how long without hearing anything before it gives
// up on the socket and redials. The gap is deliberately wide: a backgrounded tab has its timers
// throttled to roughly once a minute, and a throttled-but-healthy socket must not trip the
// watchdog.
const HEARTBEAT_MS = 25_000;
const STALE_AFTER_MS = 90_000;
// Reconnect backoff. Every reconnect now costs a full re-sync (see onConnected), so a socket that
// can't stay up — an expired token the server keeps rejecting, a backend that's down — must not
// retry at a fixed 1.5s and turn one broken tab into a steady stream of requests. A connection
// that survives HEALTHY_AFTER_MS is treated as good and resets the delay.
const RETRY_MIN_MS = 1_500;
const RETRY_MAX_MS = 30_000;
const HEALTHY_AFTER_MS = 30_000;

// Owns the single app WebSocket: connect, auto-reconnect, and the full ServerEvent dispatch that
// fans each frame into the relevant piece of chat state. The handler reads live values (open
// channel, tab focus, open Activity view) through refs so it never has to re-subscribe. Returns
// the socket ref so callers can post frames (messages, thread replies, steering).
//
// This is a behaviour-preserving lift of the effect that used to live in App: the mirror-refs are
// the intended pattern here (a long-lived socket reading current state without a stale closure),
// not incidental debt.
export function useChatSocket(opts: {
  participantId: string | null;
  getWsToken?: () => Promise<string | null>;
  workspaceId?: string; // Firebase mode: scopes the socket to the active workspace (&workspaceId=)
  // Live reads (no re-subscribe): the open channel, tab focus/visibility, the open Activity agent,
  // and the loaded channel list (to spot a message for a channel this client doesn't know yet).
  selectedRef: RefObject<string | null>;
  focusedRef: RefObject<boolean>;
  activityIdRef: RefObject<string | null>;
  channelsRef: RefObject<Channel[]>;
  // State setters.
  setChannels: Dispatch<SetStateAction<Channel[]>>;
  setPeople: Dispatch<SetStateAction<Participant[]>>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setMembers: Dispatch<SetStateAction<Participant[]>>;
  setSelected: Dispatch<SetStateAction<string | null>>;
  setConfirms: Dispatch<SetStateAction<ToolConfirm[]>>;
  setActivityEvents: Dispatch<SetStateAction<AgentEvent[]>>;
  setDeliverables: Dispatch<SetStateAction<Deliverable[]>>;
  setProfileId: Dispatch<SetStateAction<string | null>>;
  setNotice: Dispatch<SetStateAction<string>>;
  // App-level helpers the dispatch calls.
  markRead: (channelId: string) => void;
  refreshThreads: () => void;
  reloadChannels: (selectId?: string) => void;
  // Every agent_turn/agent_event frame (all agents, not just the open Activity view) — feeds
  // the ambient live-turn buffer behind the activity surfaces. `event` is null for
  // context-only frames (agent_turn).
  ingestLiveEvent: (
    agentId: string,
    turnId: string | null,
    event: unknown,
    context?: TurnContext | null,
  ) => void;
  // A dispatch landed in the agent's inbox behind a turn already in progress (agent_queued) —
  // feeds the "queued" chip until the real turn starts (or splices in) and takes over.
  ingestQueued: (agentId: string, context: TurnContext) => void;
  // Desktop-notification decisions live in App (it knows channels, mentions, prefs); the
  // dispatch just reports what happened.
  onNotifiableMessage: (m: Message, isOpen: boolean) => void;
  // Fired for every message frame and every deliverable_created frame, whoever they're for —
  // feeds the Activity page's "new activity" nudge. Keep it cheap (a counter bump).
  onAnyActivity?: () => void;
  onConfirmRequested: (c: ToolConfirm) => void;
  // Fired on every (re)connect, after the message backfill kicks off. Everything that only ever
  // arrives live — the channel list and its unread counts, the roster, threads, approvals,
  // deliverables — has to be re-fetched here: whatever happened during the gap fanned out to a
  // socket that no longer existed, and no amount of reconnecting brings those frames back.
  onConnected?: () => void;
}): RefObject<WebSocket | null> {
  const {
    participantId,
    getWsToken,
    workspaceId,
    selectedRef,
    focusedRef,
    activityIdRef,
    channelsRef,
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
    onAnyActivity,
    onConfirmRequested,
    onConnected,
  } = opts;
  const wsRef = useRef<WebSocket | null>(null);
  // Channels we've already refetched for after a message arrived naming a channel we didn't know.
  const unknownChannelsRef = useRef<Set<string>>(new Set());

  // One auto-reconnecting WebSocket. On (re)connect, backfill history for the open channel and
  // re-sync everything else (onConnected) so anything that changed while disconnected isn't
  // missed (cross-device) — a socket that comes back to a stale sidebar is barely better than one
  // that never came back.
  useEffect(() => {
    if (!participantId) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let connecting = false;
    // When we last heard ANYTHING from the server (frames or pong replies) — the watchdog's clock.
    let lastFrameAt = Date.now();
    let openedAt = 0;
    let retryDelay = RETRY_MIN_MS;

    const clearTimers = () => {
      if (retry) clearTimeout(retry);
      if (heartbeat) clearInterval(heartbeat);
      retry = heartbeat = undefined;
    };

    // Abandon the current socket and dial again immediately. Used when the watchdog decides the
    // connection is dead: close() alone isn't enough, because a half-open socket may sit in
    // CLOSING for a long time before the browser gives up and fires `close`. Detaching the
    // handlers first makes the old socket inert, so its eventual `close` can't schedule a second
    // reconnect on top of this one.
    const reconnectNow = () => {
      if (stopped) return;
      clearTimers();
      const dead = ws;
      ws = null;
      if (dead) {
        dead.onopen = dead.onmessage = dead.onclose = dead.onerror = null;
        try {
          dead.close();
        } catch {
          /* already gone */
        }
      }
      void connect();
    };

    const connect = async () => {
      // Guard the async token fetch below: a wake-up event landing mid-fetch would otherwise
      // open a second socket and leave the first one orphaned.
      if (stopped || connecting) return;
      connecting = true;
      let socket: WebSocket;
      try {
        // Firebase mode: authenticate the socket with a fresh ID token + the active workspace. Dev
        // mode: ?participantId= (which already names a workspace).
        const qs = getWsToken
          ? `token=${encodeURIComponent((await getWsToken()) ?? "")}` +
            (workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : "")
          : `participantId=${encodeURIComponent(participantId)}`;
        if (stopped) return;
        socket = new WebSocket(`${WS_BASE}/?${qs}`);
        ws = socket;
        wsRef.current = socket;
      } finally {
        connecting = false;
      }
      socket.onopen = () => {
        lastFrameAt = openedAt = Date.now();
        setNotice("");
        const ch = selectedRef.current;
        if (ch)
          // Reconcile, not merge: whatever was deleted while we were disconnected has to leave
          // local state too (its message_deleted frame went to a socket that no longer existed).
          getMessages(ch).then((hist) =>
            setMessages((prev) => reconcileHistory(prev, hist)),
          );
        onConnected?.();
        // Probe liveness on a timer. The browser answers protocol-level pings itself and never
        // tells JS, so an application ping/pong is the only way this side can tell a live socket
        // from one whose TCP connection died without a FIN (sleep, wifi switch, an idle NAT
        // reaping the flow) — that socket reports OPEN forever and silently swallows sends.
        heartbeat = setInterval(() => {
          if (stopped || socket !== ws) return;
          if (socket.readyState !== WebSocket.OPEN) {
            reconnectNow();
            return;
          }
          if (Date.now() - lastFrameAt > STALE_AFTER_MS) {
            reconnectNow();
            return;
          }
          try {
            socket.send(JSON.stringify({ type: "ping" }));
          } catch {
            reconnectNow();
          }
        }, HEARTBEAT_MS);
      };
      socket.onmessage = (e) => {
        // Any frame proves the socket is alive, `pong` included — that's all a pong is for.
        lastFrameAt = Date.now();
        // Typed against the shared ServerEvent union (same contract the backend emits), so each
        // branch below is checked against the real frame shape instead of an untyped any.
        const evt = JSON.parse(e.data) as ServerEvent;
        if (evt.type === "pong") return;
        if (evt.type === "agent_status_changed") {
          setPeople((ps) => ps.map((p) => (p.id === evt.agentId ? { ...p, status: evt.status } : p)));
          return;
        }
        if (evt.type === "device_status_changed") {
          // Account-scoped device up/down. The Environments page (not part of the chat store)
          // listens for this to flip its online dot without a refetch.
          window.dispatchEvent(new CustomEvent("jungle:device_status", { detail: evt }));
          return;
        }
        if (evt.type === "members_changed") {
          if (evt.channelId === selectedRef.current)
            listChannelMembers(evt.channelId).then(setMembers).catch(() => {});
          // Refresh the sidebar list so a channel I was just added to/removed from shows up
          // correctly even when it's not the one currently open.
          reloadChannels();
          return;
        }
        if (evt.type === "channel_created") {
          // Someone (or some agent) made a channel with me already in it. Coarse like
          // members_changed: refetch rather than splice a row in with guessed ordering/unreads.
          reloadChannels();
          return;
        }
        if (evt.type === "participant_created") {
          setPeople((ps) =>
            ps.some((p) => p.id === evt.participant.id) ? ps : [...ps, evt.participant],
          );
          return;
        }
        if (evt.type === "channel_deleted") {
          setChannels((cs) => cs.filter((c) => c.id !== evt.channelId));
          if (evt.channelId === selectedRef.current) setSelected(null);
          return;
        }
        if (evt.type === "schedule_changed") {
          // Coarse refetch signal for pages that render schedule lists (Home "Coming up", the
          // Workflows page's embedded schedules). Same relay pattern as device_status_changed.
          window.dispatchEvent(new CustomEvent("jungle:schedule-changed", { detail: evt }));
          return;
        }
        if (evt.type === "workflow_changed" || evt.type === "workflow_run_changed") {
          // Coarse refetch signal for the Workflows/Home pages (and later the builder's live
          // draft preview — the Architect edits a draft, this event makes the preview refetch).
          window.dispatchEvent(new CustomEvent("jungle:workflow-changed", { detail: evt }));
          return;
        }
        if (evt.type === "slack_link_changed") {
          // A channel's Slack mirror binding changed (linked/unlinked/errored). Relayed via a
          // window event so App updates the header badge for the open channel without threading a
          // setter through here (same pattern as device_status_changed).
          window.dispatchEvent(new CustomEvent("jungle:slack_link", { detail: evt }));
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
        if (evt.type === "agent_memory_changed") {
          // Stamp the person so an open profile's Memory section refetches (content itself is
          // pulled from GET /api/agents/:id/memory — it doesn't ride in the broadcast).
          setPeople((ps) =>
            ps.map((p) =>
              p.id === evt.agentId ? { ...p, memory_changed_at: new Date().toISOString() } : p,
            ),
          );
          return;
        }
        if (evt.type === "agent_services_changed") {
          // Same refetch pattern as memory, for the profile's Services section.
          setPeople((ps) =>
            ps.map((p) =>
              p.id === evt.agentId ? { ...p, services_changed_at: new Date().toISOString() } : p,
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
        if (evt.type === "agent_turn") {
          // A turn began (or a splice added another message to one already running): record its
          // home (channel/thread/message) in the live-turn buffer.
          ingestLiveEvent(evt.agentId, evt.turnId, null, evt.context);
          return;
        }
        if (evt.type === "agent_queued") {
          ingestQueued(evt.agentId, evt.context);
          return;
        }
        if (evt.type === "agent_event") {
          // Always feed the bounded live-turn buffer (ambient activity surfaces)…
          ingestLiveEvent(evt.agentId, evt.turnId ?? null, evt.event, evt.context);
          // …but only buffer the full stream while that agent's Activity view is open —
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
          const confirm: ToolConfirm = {
            confirmId: evt.confirmId,
            channelId: evt.channelId,
            agentId: evt.agentId,
            agentName: evt.agentName,
            agentHandle: evt.agentHandle,
            tool: evt.tool,
            input: evt.input,
            createdAt: new Date().toISOString(),
          };
          setConfirms((cs) =>
            cs.some((c) => c.confirmId === evt.confirmId) ? cs : [...cs, confirm],
          );
          onConfirmRequested(confirm);
          return;
        }
        if (evt.type === "tool_confirmation_resolved") {
          setConfirms((cs) => cs.filter((c) => c.confirmId !== evt.confirmId));
          return;
        }
        if (evt.type === "deliverable_created") {
          const d = evt.deliverable;
          setDeliverables((ds) => (ds.some((x) => x.id === d.id) ? ds : [d, ...ds]));
          onAnyActivity?.();
          return;
        }
        if (evt.type === "message_deleted") {
          // Drop it from the timeline (and from any open thread pane — replies/roots both come
          // out of `messages`). A thread ROOT with live replies is kept as a tombstone instead,
          // so the thread doesn't lose its head; the server decides which case this is.
          setMessages((prev) =>
            evt.tombstone
              ? prev.map((x) =>
                  x.id === evt.messageId
                    ? { ...x, body: "", attachments: [], deleted_at: new Date().toISOString() }
                    : x,
                )
              : prev.filter((x) => x.id !== evt.messageId),
          );
          // A deleted reply can clear the last unread reply on a thread I follow, and a deleted
          // root can retire the entry entirely — both change the Threads badge.
          if (evt.threadRootId) refreshThreads();
          return;
        }
        if (evt.type !== "message") return;
        const m: Message = evt.message;
        onAnyActivity?.();
        const isOpen = m.channel_id === selectedRef.current;
        const isMine = m.sender_id === participantId;
        // Desktop-notification decision (DMs / mentions of me, tab not looking) lives in App.
        if (!isMine) onNotifiableMessage(m, isOpen);
        // An incoming thread reply (not mine) may change my followed-threads-with-unread —
        // refresh the Threads badge/list regardless of which channel is open. (When the thread
        // is open, the reply also flows into `messages` below and the pane re-derives from it.)
        if (m.thread_root_id && !isMine) refreshThreads();
        // A message for a channel this client has never loaded: an agent or teammate opening a DM
        // with me, or a channel I was added to. There's no sidebar row to bump, so the frame used
        // to just vanish — no entry, no unread, nothing until a reload. Refetch instead. This is
        // also what makes new DMs work without announcing every findOrCreateDm: the first message
        // is what should make a DM appear anyway. Once per channel — a burst shouldn't refetch
        // once per message.
        if (!channelsRef.current?.some((c) => c.id === m.channel_id)) {
          if (!unknownChannelsRef.current.has(m.channel_id)) {
            unknownChannelsRef.current.add(m.channel_id);
            reloadChannels();
          }
          return;
        }
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
        // client twin of the listChannels SQL filter + the timeline bucketing.
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
      socket.onclose = () => {
        if (stopped || socket !== ws) return; // superseded by reconnectNow — don't dial twice
        clearTimers();
        // A connection that lasted a while was fine; whatever just dropped it is fresh trouble,
        // so start over from the short delay. One that died immediately is the failing case.
        if (openedAt && Date.now() - openedAt >= HEALTHY_AFTER_MS) retryDelay = RETRY_MIN_MS;
        const delay = retryDelay;
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
        retry = setTimeout(() => void connect(), delay);
      };
    };

    // Coming back from a background tab, a sleeping laptop or an offline network is exactly when
    // the socket is most likely to be quietly dead, and it's the moment the user is about to look
    // at the screen. Check then instead of waiting up to a full heartbeat.
    const wake = () => {
      if (stopped || connecting) return;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        // The user just came back / the network just returned — retry now rather than sitting out
        // whatever backoff the previous failures accumulated.
        retryDelay = RETRY_MIN_MS;
        clearTimers();
        void connect();
        return;
      }
      if (ws.readyState === WebSocket.OPEN && Date.now() - lastFrameAt > STALE_AFTER_MS) reconnectNow();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") wake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);

    void connect();
    return () => {
      stopped = true;
      clearTimers();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participantId]);

  return wsRef;
}
