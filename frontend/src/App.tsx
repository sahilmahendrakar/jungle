import { useEffect, useRef, useState } from "react";
import {
  listChannels, getMessages, listParticipants, createChannel, WS_BASE,
  type Channel, type Message, type Participant,
} from "./api";
import { SignIn } from "./SignIn";

function mergeById(a: Message[], b: Message[]): Message[] {
  const map = new Map<string, Message>();
  for (const m of [...a, ...b]) map.set(m.id, m);
  return [...map.values()].sort((x, y) => Number(x.seq) - Number(y.seq));
}

// Works in non-secure contexts (e.g. http://<ip>) where crypto.randomUUID is undefined.
const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function App() {
  const participantId = new URLSearchParams(location.search).get("as");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [people, setPeople] = useState<Participant[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  // New-channel form
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMembers, setNewMembers] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const me = people.find((p) => p.id === participantId);

  function reloadChannels(selectId?: string) {
    if (!participantId) return;
    listChannels(participantId).then((cs) => {
      setChannels(cs);
      setSelected((s) => selectId ?? s ?? cs[0]?.id ?? null);
    });
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
        setNotice("");
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
    if (!body) return;
    if (!selected) { setNotice("Pick or create a channel first."); return; }
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setNotice("Connecting to the server… try again in a moment.");
      return;
    }
    // No optimistic echo — the message appears when it round-trips back over WS,
    // which proves the full send -> persist -> fan-out -> render loop.
    wsRef.current.send(JSON.stringify({ type: "post", channelId: selected, body, clientMsgId: newId() }));
    setDraft("");
    setNotice("");
  }

  async function submitNewChannel() {
    const name = newName.trim();
    if (!name || !me) { setNotice("Channel name is required."); return; }
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

  if (!participantId) return <SignIn />;

  const sel = channels.find((c) => c.id === selected);
  const others = people.filter((p) => p.id !== participantId);

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif" }}>
      {/* Sidebar */}
      <aside style={{ width: 240, background: "#1f2430", color: "#cdd3df", padding: "12px 8px", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 8px 12px" }}>
          <span style={{ fontWeight: 700, fontSize: 18 }}>🌴 Jungle</span>
          {me && <span style={{ fontSize: 12, color: "#8b93a7" }}>@{me.handle}</span>}
        </div>

        {channels.length === 0 && (
          <div style={{ color: "#8b93a7", fontSize: 13, padding: "4px 8px 10px" }}>
            No channels yet — create one below.
          </div>
        )}
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

        <button
          data-testid="new-channel-toggle"
          onClick={() => setShowNew((v) => !v)}
          style={{
            display: "block", width: "100%", textAlign: "left", cursor: "pointer", marginTop: 8,
            padding: "6px 8px", borderRadius: 6, border: "1px dashed #3a4150", background: "transparent",
            color: "#9aa3b5", font: "inherit",
          }}
        >
          ＋ New channel
        </button>

        {showNew && (
          <div style={{ marginTop: 8, padding: 8, background: "#272d3a", borderRadius: 8 }}>
            <input
              data-testid="new-channel-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="channel name"
              style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #3a4150", background: "#1f2430", color: "#cdd3df", font: "inherit", boxSizing: "border-box", marginBottom: 8 }}
            />
            <div style={{ fontSize: 12, color: "#8b93a7", marginBottom: 4 }}>Members (you're always included):</div>
            <div style={{ maxHeight: 160, overflowY: "auto", marginBottom: 8 }}>
              {others.map((p) => {
                const on = newMembers.includes(p.handle);
                return (
                  <label
                    key={p.id}
                    data-testid="member-option"
                    style={{ display: "flex", gap: 6, alignItems: "center", padding: "3px 4px", cursor: "pointer", fontSize: 13 }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setNewMembers((m) => (on ? m.filter((h) => h !== p.handle) : [...m, p.handle]))
                      }
                    />
                    {p.kind === "agent" ? "🤖" : "🙂"} @{p.handle}
                  </label>
                );
              })}
              {others.length === 0 && <div style={{ color: "#8b93a7", fontSize: 12 }}>No one else yet.</div>}
            </div>
            <button
              data-testid="create-channel-button"
              onClick={submitNewChannel}
              disabled={creating}
              style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#2f6feb", color: "#fff", cursor: creating ? "default" : "pointer", opacity: creating ? 0.6 : 1, font: "inherit" }}
            >
              {creating ? "Creating…" : "Create channel"}
            </button>
          </div>
        )}
      </aside>

      {/* Main */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", background: "#fff" }}>
        <header style={{ padding: "12px 16px", borderBottom: "1px solid #e6e6e6", fontWeight: 600 }}>
          {sel ? (sel.kind === "dm" ? "@" : "#") + sel.name : "Select or create a channel"}
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

        {notice && (
          <div data-testid="send-notice" style={{ padding: "6px 16px", color: "#b23", fontSize: 13, background: "#fff4f4" }}>
            {notice}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid #e6e6e6" }}>
          <input
            data-testid="composer-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") send(); }}
            placeholder={sel ? `Message ${sel.kind === "dm" ? "@" : "#"}${sel.name}` : "Select or create a channel"}
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
