// The chat store — a zustand store holding all realtime chat state. Ported from the web app's
// useChatSocket dispatch (frontend/src/ws/useChatSocket.ts): each ServerEvent branch here mirrors
// the corresponding setState there, adapted to a keyed-by-channel store so multiple channel
// screens can coexist under navigation. Created with zustand's vanilla `create`, so the socket
// manager (non-React) mutates it via useChatStore.getState() while components subscribe via the hook.
import { create } from "zustand";
import type { ServerEvent } from "@jungle/shared";
import {
  listChannels,
  listChannelMembers,
  listUnreadThreads,
  markChannelRead,
  type AgentEvent,
  type Channel,
  type Deliverable,
  type Message,
  type Participant,
  type PendingConfirmation,
  type UnreadThread,
} from "../lib/api";
import {
  ingestLiveEvent,
  ingestQueued,
  resetLiveTurns,
  setLiveBump,
} from "./liveTurns";

const MAX_ACTIVITY_EVENTS = 400;

// Merge two message lists by id, preserving order and de-duping (twin of the web's mergeById).
function mergeById(a: Message[], b: Message[]): Message[] {
  const seen = new Set(a.map((m) => m.id));
  return [...a, ...b.filter((m) => !seen.has(m.id))];
}

interface ChatState {
  connected: boolean;
  appActive: boolean;
  myParticipantId: string | null;

  channels: Channel[];
  people: Participant[];
  messagesByChannel: Record<string, Message[]>;
  membersByChannel: Record<string, Participant[]>;
  confirms: PendingConfirmation[];
  deliverables: Deliverable[];
  unreadThreads: UnreadThread[];
  selectedChannelId: string | null;

  // Throttled counter bumped by the liveTurns module so turn-chip consumers re-render (~4/s).
  liveVersion: number;
  // The agent whose Activity transcript is open (drives the live-event buffer below); null = none.
  activityAgentId: string | null;
  activityEvents: AgentEvent[];
  // Coarse "schedules changed" flag; the Scheduled screen refetches when it sees this.
  schedulesStale: number;

  // lifecycle / bulk setters (used by initial fetches + the socket manager)
  setConnected: (b: boolean) => void;
  setAppActive: (b: boolean) => void;
  setMyParticipantId: (id: string | null) => void;
  setChannels: (cs: Channel[]) => void;
  setPeople: (ps: Participant[]) => void;
  setDeliverables: (ds: Deliverable[]) => void;
  setConfirms: (cs: PendingConfirmation[]) => void;
  setUnreadThreads: (t: UnreadThread[]) => void;
  refreshThreads: () => void;
  setActivityAgent: (id: string | null, events?: AgentEvent[]) => void;
  setSelected: (id: string | null) => void;
  setChannelMessages: (channelId: string, msgs: Message[]) => void;
  mergeChannelMessages: (channelId: string, msgs: Message[]) => void;
  setChannelMembers: (channelId: string, members: Participant[]) => void;
  reloadChannels: () => void;
  // Clear all per-workspace state (on workspace switch) so nothing bleeds across workspaces.
  resetWorkspaceState: () => void;

  // the full ServerEvent dispatch
  handleEvent: (evt: ServerEvent) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  connected: false,
  appActive: true,
  myParticipantId: null,
  channels: [],
  people: [],
  messagesByChannel: {},
  membersByChannel: {},
  confirms: [],
  deliverables: [],
  unreadThreads: [],
  selectedChannelId: null,
  liveVersion: 0,
  activityAgentId: null,
  activityEvents: [],
  schedulesStale: 0,

  setConnected: (b) => set({ connected: b }),
  setAppActive: (b) => set({ appActive: b }),
  setMyParticipantId: (id) => set({ myParticipantId: id }),
  setChannels: (cs) => set({ channels: cs }),
  setPeople: (ps) => set({ people: ps }),
  setDeliverables: (ds) => set({ deliverables: ds }),
  setConfirms: (cs) => set({ confirms: cs }),
  setUnreadThreads: (t) => set({ unreadThreads: t }),
  refreshThreads: () => {
    listUnreadThreads()
      .then((t) => set({ unreadThreads: t }))
      .catch(() => {});
  },
  setActivityAgent: (id, events = []) => set({ activityAgentId: id, activityEvents: events }),
  setSelected: (id) => set({ selectedChannelId: id }),
  setChannelMessages: (channelId, msgs) =>
    set((s) => ({ messagesByChannel: { ...s.messagesByChannel, [channelId]: msgs } })),
  mergeChannelMessages: (channelId, msgs) =>
    set((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [channelId]: mergeById(s.messagesByChannel[channelId] ?? [], msgs),
      },
    })),
  setChannelMembers: (channelId, members) =>
    set((s) => ({ membersByChannel: { ...s.membersByChannel, [channelId]: members } })),

  reloadChannels: () => {
    const pid = get().myParticipantId;
    if (!pid) return;
    listChannels(pid)
      .then((cs) => set({ channels: cs }))
      .catch(() => {});
  },

  resetWorkspaceState: () => {
    resetLiveTurns();
    set({
      channels: [],
      people: [],
      messagesByChannel: {},
      membersByChannel: {},
      confirms: [],
      deliverables: [],
      unreadThreads: [],
      selectedChannelId: null,
      activityAgentId: null,
      activityEvents: [],
    });
  },

  handleEvent: (evt) => {
    const s = get();
    switch (evt.type) {
      case "agent_status_changed":
        set({ people: s.people.map((p) => (p.id === evt.agentId ? { ...p, status: evt.status } : p)) });
        return;
      case "members_changed":
        if (evt.channelId === s.selectedChannelId)
          listChannelMembers(evt.channelId)
            .then((m) => get().setChannelMembers(evt.channelId, m))
            .catch(() => {});
        get().reloadChannels();
        return;
      case "channel_deleted":
        set({
          channels: s.channels.filter((c) => c.id !== evt.channelId),
          selectedChannelId: s.selectedChannelId === evt.channelId ? null : s.selectedChannelId,
        });
        return;
      case "participant_updated":
        set({
          people: s.people.map((p) => (p.id === evt.participant.id ? { ...p, ...evt.participant } : p)),
        });
        return;
      case "agent_context":
        set({
          people: s.people.map((p) =>
            p.id === evt.agentId
              ? {
                  ...p,
                  context_tokens: evt.tokens,
                  context_max_tokens: evt.maxTokens,
                  context_updated_at: new Date().toISOString(),
                }
              : p,
          ),
        });
        return;
      case "agent_memory_changed":
        set({
          people: s.people.map((p) =>
            p.id === evt.agentId ? { ...p, memory_changed_at: new Date().toISOString() } : p,
          ),
        });
        return;
      case "participant_deleted": {
        const gone = s.people.find((p) => p.id === evt.participantId);
        const dm = gone
          ? s.channels.find((c) => c.kind === "dm" && c.dm_with === gone.handle)
          : undefined;
        set({
          people: s.people.filter((p) => p.id !== evt.participantId),
          channels: dm ? s.channels.filter((c) => c.id !== dm.id) : s.channels,
          selectedChannelId:
            dm && s.selectedChannelId === dm.id ? null : s.selectedChannelId,
        });
        return;
      }
      case "tool_confirmation_request":
        set({
          confirms: s.confirms.some((c) => c.confirmId === evt.confirmId)
            ? s.confirms
            : [
                ...s.confirms,
                {
                  confirmId: evt.confirmId,
                  channelId: evt.channelId,
                  agentId: evt.agentId,
                  agentName: evt.agentName,
                  agentHandle: evt.agentHandle,
                  tool: evt.tool,
                  input: evt.input,
                  createdAt: new Date().toISOString(),
                },
              ],
        });
        return;
      case "tool_confirmation_resolved":
        set({ confirms: s.confirms.filter((c) => c.confirmId !== evt.confirmId) });
        return;
      case "deliverable_created":
        set({
          deliverables: s.deliverables.some((x) => x.id === evt.deliverable.id)
            ? s.deliverables
            : [evt.deliverable, ...s.deliverables],
        });
        return;
      case "message": {
        const m = evt.message;
        const isOpen = m.channel_id === s.selectedChannelId;
        const isMine = m.sender_id === s.myParticipantId;
        // Append to the channel's message list (dedup) so an open screen renders it live.
        if (isOpen || s.messagesByChannel[m.channel_id]) {
          const cur = s.messagesByChannel[m.channel_id] ?? [];
          if (!cur.some((x) => x.id === m.id))
            set({ messagesByChannel: { ...s.messagesByChannel, [m.channel_id]: [...cur, m] } });
        }
        // Read-marker: looking right at this channel (open + app foregrounded) → mark read.
        if (isOpen && s.appActive && !isMine) {
          markChannelRead(m.channel_id).catch(() => {});
          return;
        }
        // Otherwise bump unread on the channel — skipping my own messages and pure thread replies
        // (which have their own per-thread unread), mirroring the web's channel-badge rule.
        if (isMine || !(!m.thread_root_id || m.also_to_channel)) return;
        const mentionsMe = (m.mentions ?? []).some((x) => x.id === s.myParticipantId);
        set({
          channels: s.channels.map((c) =>
            c.id === m.channel_id
              ? {
                  ...c,
                  unread_count: (c.unread_count ?? 0) + 1,
                  has_mention: c.has_mention || mentionsMe,
                }
              : c,
          ),
        });
        // A thread reply from someone else bumps the Threads badge (mirrors the web).
        if (m.thread_root_id && !isMine) get().refreshThreads();
        return;
      }
      // Live agent turns → the trigger-message chips + ambient status surfaces (liveTurns module).
      case "agent_turn":
        ingestLiveEvent(evt.agentId, evt.turnId, null, evt.context);
        return;
      case "agent_event": {
        ingestLiveEvent(evt.agentId, evt.turnId, evt.event, evt.context);
        // If this agent's Activity transcript is open, append to its live buffer.
        if (s.activityAgentId === evt.agentId) {
          const next = [
            ...s.activityEvents,
            {
              id: Date.now() + Math.random(),
              turn_id: evt.turnId,
              event: evt.event,
              created_at: new Date().toISOString(),
            },
          ];
          set({ activityEvents: next.length > MAX_ACTIVITY_EVENTS ? next.slice(-MAX_ACTIVITY_EVENTS) : next });
        }
        return;
      }
      case "agent_queued":
        ingestQueued(evt.agentId, evt.context);
        return;
      case "schedule_changed":
        set({ schedulesStale: s.schedulesStale + 1 });
        return;
      default:
        return;
    }
  },
}));

// Bridge the liveTurns module's throttled tick into a store counter so chip consumers re-render.
setLiveBump(() => useChatStore.setState((s) => ({ liveVersion: s.liveVersion + 1 })));
