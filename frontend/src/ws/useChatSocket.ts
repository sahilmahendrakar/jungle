import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ServerEvent } from "@jungle/shared";
import {
  WS_BASE,
  getMessages,
  listChannelMembers,
  type AgentEvent,
  type Channel,
  type Message,
  type Participant,
} from "../api";
import { mergeById, type ToolConfirm } from "../lib/chat";

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
  // Live reads (no re-subscribe): the open channel, tab focus/visibility, the open Activity agent.
  selectedRef: RefObject<string | null>;
  focusedRef: RefObject<boolean>;
  activityIdRef: RefObject<string | null>;
  // State setters.
  setChannels: Dispatch<SetStateAction<Channel[]>>;
  setPeople: Dispatch<SetStateAction<Participant[]>>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setMembers: Dispatch<SetStateAction<Participant[]>>;
  setSelected: Dispatch<SetStateAction<string | null>>;
  setConfirms: Dispatch<SetStateAction<ToolConfirm[]>>;
  setActivityEvents: Dispatch<SetStateAction<AgentEvent[]>>;
  setProfileId: Dispatch<SetStateAction<string | null>>;
  setNotice: Dispatch<SetStateAction<string>>;
  // App-level helpers the dispatch calls.
  markRead: (channelId: string) => void;
  refreshThreads: () => void;
  reloadChannels: (selectId?: string) => void;
}): RefObject<WebSocket | null> {
  const {
    participantId,
    getWsToken,
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
    setProfileId,
    setNotice,
    markRead,
    refreshThreads,
    reloadChannels,
  } = opts;
  const wsRef = useRef<WebSocket | null>(null);

  // One auto-reconnecting WebSocket. On (re)connect, backfill history for the open channel so
  // anything that arrived while disconnected isn't missed (cross-device).
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
          // Refresh the sidebar list so a channel I was just added to/removed from shows up
          // correctly even when it's not the one currently open.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participantId]);

  return wsRef;
}
