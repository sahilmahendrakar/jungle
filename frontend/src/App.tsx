import { useEffect, useRef, useState } from "react";
import {
  listChannels, getMessages, listParticipants, createChannel, createDm, createParticipant, WS_BASE,
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
  const [addingAgent, setAddingAgent] = useState(false);
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
        if (evt.type === "agent_status") {
          setWorking((w) => {
            const set = new Set(w[evt.channelId] ?? []);
            if (evt.state === "working") set.add(evt.handle);
            else set.delete(evt.handle);
            return { ...w, [evt.channelId]: [...set] };
          });
          return;
        }
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

  function signOut() {
    window.location.search = ""; // drop ?as= -> back to the sign-in screen
  }

  async function openDm(otherId: string) {
    if (!participantId) return;
    try {
      const { id } = await createDm(participantId, otherId);
      reloadChannels(id);
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    }
  }

  async function submitAddAgent() {
    if (!agHandle.trim() || !agName.trim()) { setNotice("Agent handle and name are required."); return; }
    setAddingAgent(true);
    try {
      await createParticipant({
        kind: "agent", handle: agHandle.trim(), displayName: agName.trim(),
        repo: agRepo.trim() || undefined,
      });
      setShowAddAgent(false);
      setAgHandle(""); setAgName(""); setAgRepo("");
      listParticipants().then(setPeople).catch(() => {});
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    } finally {
      setAddingAgent(false);
    }
  }

  if (!participantId) return <SignIn />;

  const sel = channels.find((c) => c.id === selected);
  const others = people.filter((p) => p.id !== participantId);
  const rooms = channels.filter((c) => c.kind !== "dm");
  const dms = channels.filter((c) => c.kind === "dm");
  const label = (c: Channel) => (c.kind === "dm" ? `@${c.dm_with ?? "dm"}` : `# ${c.name}`);
  const dmChannelWith = (handle: string) => dms.find((c) => c.dm_with === handle);

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif" }}>
      {/* Sidebar */}
      <aside style={{ width: 240, background: "#1f2430", color: "#cdd3df", padding: "12px 8px", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 8px 12px" }}>
          <span style={{ fontWeight: 700, fontSize: 18 }}>🌴 Jungle</span>
          {me && (
            <span style={{ fontSize: 12, color: "#8b93a7" }}>
              @{me.handle}{" "}
              <button
                data-testid="switch-user"
                onClick={signOut}
                title="Switch user"
                style={{ marginLeft: 4, cursor: "pointer", background: "transparent", border: "none", color: "#6ea8fe", font: "inherit", padding: 0 }}
              >
                switch
              </button>
            </span>
          )}
        </div>

        {/* Channels */}
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "#6b7280", padding: "8px 8px 4px" }}>Channels</div>
        {rooms.map((c) => (
          <button
            key={c.id}
            data-testid="channel-item"
            onClick={() => setSelected(c.id)}
            style={{
              display: "block", width: "100%", textAlign: "left", border: "none", cursor: "pointer",
              padding: "6px 8px", borderRadius: 6, marginBottom: 2,
              background: c.id === selected ? "#3a4150" : "transparent", color: "inherit", font: "inherit",
            }}
          >
            {label(c)}
          </button>
        ))}
        <button
          data-testid="new-channel-toggle"
          onClick={() => setShowNew((v) => !v)}
          style={{
            display: "block", width: "100%", textAlign: "left", cursor: "pointer", marginTop: 4,
            padding: "6px 8px", borderRadius: 6, border: "1px dashed #3a4150", background: "transparent",
            color: "#9aa3b5", font: "inherit",
          }}
        >
          ＋ New channel
        </button>

        {/* Direct messages */}
        {dms.length > 0 && (
          <>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "#6b7280", padding: "12px 8px 4px" }}>Direct messages</div>
            {dms.map((c) => (
              <button
                key={c.id}
                data-testid="channel-item"
                onClick={() => setSelected(c.id)}
                style={{
                  display: "block", width: "100%", textAlign: "left", border: "none", cursor: "pointer",
                  padding: "6px 8px", borderRadius: 6, marginBottom: 2,
                  background: c.id === selected ? "#3a4150" : "transparent", color: "inherit", font: "inherit",
                }}
              >
                {label(c)}
              </button>
            ))}
          </>
        )}

        {/* People — click to DM */}
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "#6b7280", padding: "12px 8px 4px" }}>People</div>
        {others.map((p) => (
          <button
            key={p.id}
            data-testid="people-item"
            onClick={() => {
              const existing = dmChannelWith(p.handle);
              if (existing) setSelected(existing.id);
              else openDm(p.id);
            }}
            style={{
              display: "block", width: "100%", textAlign: "left", border: "none", cursor: "pointer",
              padding: "6px 8px", borderRadius: 6, marginBottom: 2, background: "transparent", color: "inherit", font: "inherit",
            }}
          >
            {p.kind === "agent" ? "🤖" : "🙂"} @{p.handle}
          </button>
        ))}
        {others.length === 0 && <div style={{ color: "#6b7280", fontSize: 12, padding: "2px 8px" }}>No one else yet.</div>}
        <button
          data-testid="add-agent-toggle"
          onClick={() => setShowAddAgent((v) => !v)}
          style={{
            display: "block", width: "100%", textAlign: "left", cursor: "pointer", marginTop: 4,
            padding: "6px 8px", borderRadius: 6, border: "1px dashed #3a4150", background: "transparent",
            color: "#9aa3b5", font: "inherit",
          }}
        >
          ＋ Add agent
        </button>

        {showAddAgent && (
          <div style={{ marginTop: 8, padding: 8, background: "#272d3a", borderRadius: 8 }}>
            <input
              data-testid="agent-handle" value={agHandle} onChange={(e) => setAgHandle(e.target.value)}
              placeholder="handle (e.g. deploy-bot)"
              style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #3a4150", background: "#1f2430", color: "#cdd3df", font: "inherit", boxSizing: "border-box", marginBottom: 8 }}
            />
            <input
              data-testid="agent-name" value={agName} onChange={(e) => setAgName(e.target.value)}
              placeholder="display name"
              style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #3a4150", background: "#1f2430", color: "#cdd3df", font: "inherit", boxSizing: "border-box", marginBottom: 8 }}
            />
            <input
              data-testid="agent-repo" value={agRepo} onChange={(e) => setAgRepo(e.target.value)}
              placeholder="repo (optional, owner/name)"
              style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #3a4150", background: "#1f2430", color: "#cdd3df", font: "inherit", boxSizing: "border-box", marginBottom: 8 }}
            />
            <button
              data-testid="add-agent-button" onClick={submitAddAgent} disabled={addingAgent}
              style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#2f6feb", color: "#fff", cursor: addingAgent ? "default" : "pointer", opacity: addingAgent ? 0.6 : 1, font: "inherit" }}
            >
              {addingAgent ? "Adding…" : "Add agent"}
            </button>
            {agRepo.trim() && <div style={{ fontSize: 11, color: "#8b93a7", marginTop: 6 }}>With a repo this takes ~30s (clones it).</div>}
          </div>
        )}

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
          {sel ? label(sel) : "Select or create a channel"}
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

        {selected && (working[selected]?.length ?? 0) > 0 && (
          <div data-testid="working-indicator" style={{ padding: "6px 16px", color: "#2f6feb", fontSize: 13, fontStyle: "italic" }}>
            {working[selected].map((h) => `@${h}`).join(", ")} {working[selected].length > 1 ? "are" : "is"} working…
          </div>
        )}

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
            placeholder={sel ? `Message ${label(sel)}` : "Select or create a channel"}
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
