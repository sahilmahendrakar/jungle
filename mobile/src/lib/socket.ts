// The app WebSocket manager. Ported from frontend/src/ws/useChatSocket.ts, but as a plain
// singleton (not a hook) so it can live across navigation and be driven by the auth lifecycle.
// Responsibilities:
//   - connect to wss://<base>/?token=<fresh Firebase ID token>&workspaceId=<id>, minting a FRESH
//     token per attempt (a queued reconnect must never reuse an expired querystring token);
//   - dispatch every ServerEvent into the zustand chat store;
//   - 1.5s reconnect backoff, with an open-channel backfill + full resync on every (re)connect;
//   - AppState handling: iOS suspends sockets in the background, so we stop retrying while
//     backgrounded and reconnect + resync the moment we return to the foreground.
import { AppState, type AppStateStatus } from "react-native";
import type { ServerEvent, ClientFrame } from "@jungle/shared";
import { getWsBase } from "./config";
import {
  getMessages,
  getChannelTurnChips,
  listChannels,
  listDeliverables,
  listPendingConfirms,
} from "./api";
import { hydrateChannel } from "../store/liveTurns";
import { useChatStore } from "../store/chat";

interface SocketConfig {
  getToken: () => Promise<string | null>;
  workspaceId: string | null;
  participantId: string | null; // dev-bypass identity; null in Firebase mode
}

class AppSocket {
  private ws: WebSocket | null = null;
  private cfg: SocketConfig | null = null;
  private stopped = true;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private appStateSub: { remove: () => void } | null = null;

  start(cfg: SocketConfig) {
    this.stop();
    this.cfg = cfg;
    this.stopped = false;
    this.appStateSub = AppState.addEventListener("change", this.onAppStateChange);
    void this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.ws?.close();
    this.ws = null;
    useChatStore.getState().setConnected(false);
  }

  // Post a message/thread-reply frame. Returns false if the socket isn't open.
  post(frame: ClientFrame): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }

  private onAppStateChange = (state: AppStateStatus) => {
    const store = useChatStore.getState();
    store.setAppActive(state === "active");
    if (state === "active") {
      // Returned to foreground: the socket likely died while suspended. Reconnect + resync.
      if (!this.ws || this.ws.readyState > WebSocket.OPEN) void this.connect();
    } else if (state === "background") {
      // Stop burning reconnect attempts while suspended; the socket will be re-established on
      // the next "active".
      if (this.retry) clearTimeout(this.retry);
    }
  };

  private async connect() {
    if (this.stopped || !this.cfg) return;
    const { getToken, workspaceId, participantId } = this.cfg;
    // Fresh token per attempt (never cache the querystring token).
    const qs = participantId
      ? `participantId=${encodeURIComponent(participantId)}`
      : `token=${encodeURIComponent((await getToken()) ?? "")}` +
        (workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : "");
    if (this.stopped) return;

    const ws = new WebSocket(`${getWsBase()}/?${qs}`);
    this.ws = ws;

    ws.onopen = () => {
      useChatStore.getState().setConnected(true);
      void this.resync();
    };
    ws.onmessage = (e) => {
      let evt: ServerEvent & { participantId?: string };
      try {
        evt = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (evt.type === "connected") {
        if (evt.participantId) useChatStore.getState().setMyParticipantId(evt.participantId);
        return;
      }
      useChatStore.getState().handleEvent(evt);
    };
    ws.onclose = () => {
      useChatStore.getState().setConnected(false);
      if (!this.stopped && AppState.currentState === "active") {
        this.retry = setTimeout(() => void this.connect(), 1500);
      }
    };
    ws.onerror = () => {
      // onclose will follow and schedule the retry.
    };
  }

  // Re-sync state that only fans out live (so nothing is missed across a disconnect): the open
  // channel's history + turn chips, the channel list (unreads), pending confirmations, unread
  // threads, and the deliverables feed.
  private async resync() {
    const store = useChatStore.getState();
    const openId = store.selectedChannelId;
    if (openId) {
      getMessages(openId)
        .then((hist) => useChatStore.getState().mergeChannelMessages(openId, hist))
        .catch(() => {});
      getChannelTurnChips(openId)
        .then((r) => hydrateChannel(openId, r.turns, r.queued))
        .catch(() => {});
    }
    const pid = store.myParticipantId;
    if (pid) {
      listChannels(pid)
        .then((cs) => useChatStore.getState().setChannels(cs))
        .catch(() => {});
    }
    listPendingConfirms()
      .then((cs) => useChatStore.getState().setConfirms(cs))
      .catch(() => {});
    store.refreshThreads();
    listDeliverables()
      .then((ds) => useChatStore.getState().setDeliverables(ds))
      .catch(() => {});
  }
}

// Single instance shared across the app.
export const appSocket = new AppSocket();
