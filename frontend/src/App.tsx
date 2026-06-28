import { useEffect, useRef, useState } from "react";
import { listChannels, getMessages, WS_BASE, type Channel, type Message } from "./api";

function mergeById(a: Message[], b: Message[]): Message[] {
  const map = new Map<string, Message>();
  for (const m of [...a, ...b]) map.set(m.id, m);
  return [...map.values()].sort((x, y) => Number(x.seq) - Number(y.seq));
}

export function App() {
  const participantId = new URLSearchParams(location.search).get("as");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  // Load the channels this participant belongs to.
  useEffect(() => {
    if (!participantId) return;
    listChannels(participantId).then((cs) => {
      setChannels(cs);
      setSelected((s) => s ?? cs[0]?.id ?? null);
    });
  }, [participantId]);

  // Load history when the selected channel changes.
  useEffect(() => {
    if (!selected) return;
    getMessages(selected).then(setMessages);
  }, [selected]);

  // One auto-reconnecting WebSocket. On (re)connect, backfill history for the open
  // channel so anything that arrived while disconnected isn't missed (cross-device).
  useEffect(() => {
    if (!participantId) return;
    let stopped = false;
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      ws = new WebSocket(`${WS_BASE}/?participantId=${participantId}`);
      wsRef.current = ws;
      ws.onopen = () => {
        const ch = selectedRef.current;
        if (ch) getMessages(ch).then((hist) => setMessages((prev) => mergeById(prev, hist)));
      };
      ws.onmessage = (e) => {
        const evt = JSON.parse(e.data);
        if (evt.type !== "message") return;
        const m: Message = evt.message;
        if (m.channel_id !== selectedRef.current) return;
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
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
    if (!body || !selected || wsRef.current?.readyState !== WebSocket.OPEN) return;
    // No optimistic echo — the message appears when it round-trips back over WS,
    // which proves the full send -> persist -> fan-out -> render loop.
    wsRef.current.send(JSON.stringify({ type: "post", channelId: selected, body, clientMsgId: crypto.randomUUID() }));
    setDraft("");
  }

  if (!participantId) {
    return (
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <h1>🌴 Jungle</h1>
        <p>Add <code>?as=&lt;participantId&gt;</code> to the URL to sign in.</p>
      </main>
    );
  }

  const sel = channels.find((c) => c.id === selected);

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif" }}>
      {/* Sidebar */}
      <aside style={{ width: 220, background: "#1f2430", color: "#cdd3df", padding: "12px 8px", overflowY: "auto" }}>
        <div style={{ fontWeight: 700, fontSize: 18, padding: "4px 8px 12px" }}>🌴 Jungle</div>
        {channels.map((c) => (
          <button
            key={c.id}
            data-testid="channel-item"
            onClick={() => setSelected(c.id)}
            style={{
              display: "block", width: "100%", textAlign: "left", border: "none", cursor: "pointer",
              padding: "6px 8px", borderRadius: 6, marginBottom: 2,
              background: c.id === selected ? "#3a4150" : "transparent",
              color: "inherit", font: "inherit",
            }}
          >
            {c.kind === "dm" ? "@ " : "# "}{c.name}
          </button>
        ))}
      </aside>

      {/* Main */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", background: "#fff" }}>
        <header style={{ padding: "12px 16px", borderBottom: "1px solid #e6e6e6", fontWeight: 600 }}>
          {sel ? (sel.kind === "dm" ? "@" : "#") + sel.name : "Select a channel"}
        </header>

        <div data-testid="message-list" style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
          {messages.map((m) => (
            <div key={m.id} data-testid="message" style={{ marginBottom: 10 }}>
              <span data-testid="message-sender" style={{ fontWeight: 600 }}>@{m.sender_handle}</span>{" "}
              <span style={{ color: "#888", fontSize: 12 }}>
                {new Date(m.created_at).toLocaleTimeString()}
              </span>
              <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid #e6e6e6" }}>
          <input
            data-testid="composer-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") send(); }}
            placeholder={sel ? `Message ${sel.kind === "dm" ? "@" : "#"}${sel.name}` : "Select a channel"}
            style={{ flex: 1, padding: "8px 10px", borderRadius: 6, border: "1px solid #ccc", font: "inherit" }}
          />
          <button data-testid="send-button" onClick={send} style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: "#2f6feb", color: "#fff", cursor: "pointer" }}>
            Send
          </button>
        </div>
      </main>
    </div>
  );
}
