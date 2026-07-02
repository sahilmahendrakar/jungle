// Outbound WebSocket to the Jungle backend with reconnect + backoff.
// Owns framing (JSON encode/decode); delegates frame handling to a callback.
import WebSocket from "ws";
import { log } from "./log.js";
import type { BackendToRunner, RunnerToBackend } from "./protocol.js";

export interface ConnectionHandlers {
  onFrame: (frame: BackendToRunner) => void;
  onOpen: () => void;
  onClose: () => void;
}

export class Connection {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoffMs = 500;
  private readonly maxBackoffMs = 30_000;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly token: string,
    private readonly handlers: ConnectionHandlers,
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const sep = this.wsUrl.includes("?") ? "&" : "?";
    const url = `${this.wsUrl}${sep}token=${encodeURIComponent(this.token)}`;
    log.info("connecting to backend", { wsUrl: this.wsUrl });
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.backoffMs = 500;
      log.info("backend connection open");
      this.handlers.onOpen();
    });

    ws.on("message", (data) => {
      let frame: BackendToRunner;
      try {
        frame = JSON.parse(data.toString());
      } catch (err) {
        log.warn("failed to parse backend frame", { err: String(err) });
        return;
      }
      try {
        this.handlers.onFrame(frame);
      } catch (err) {
        log.error("frame handler threw", { type: (frame as any)?.type, err: String(err) });
      }
    });

    ws.on("close", (code) => {
      log.warn("backend connection closed", { code });
      this.ws = null;
      this.handlers.onClose();
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      log.warn("backend connection error", { err: String(err) });
      // 'close' fires after 'error'; reconnect is scheduled there.
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    log.info("scheduling reconnect", { delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(frame: RunnerToBackend): boolean {
    if (!this.isOpen || !this.ws) {
      log.warn("dropping frame: socket not open", { type: frame.type });
      return false;
    }
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      log.error("failed to send frame", { type: frame.type, err: String(err) });
      return false;
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
