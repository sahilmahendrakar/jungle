"use client";

import { useEffect, useState } from "react";
import { api, API_URL, type WireChannels } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";

// The three ways to talk to Liana, as self-serve cards: Slack (install), iMessage (verify a
// phone), Telegram (deep link). Self-contained — fetches channel status itself — so both
// Settings and the first-run home state can drop it in.

export function ChannelCards() {
  const { refreshMe } = useAuth();
  const [channels, setChannels] = useState<WireChannels["channels"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<WireChannels>("/api/liana/channels")
      .then((c) => setChannels(c.channels))
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  if (error) return <p className="error-note">{error}</p>;
  if (!channels) return <p className="muted">Loading…</p>;

  return (
    <>
      <SlackCard state={channels.slack} onChanged={() => void load().then(() => void refreshMe())} />
      {channels.imessage && <IMessageCard state={channels.imessage} onChanged={() => void load()} />}
      {channels.telegram && <TelegramCard state={channels.telegram} onChanged={() => void load()} />}
    </>
  );
}

function SlackCard(props: { state: { connected: boolean; teamName: string | null }; onChanged: () => void }) {
  // Install completes on the backend's callback page; poll briefly so the card flips without a
  // manual refresh once the user finishes the OAuth dance in the other tab.
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!waiting || props.state.connected) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 180_000) {
        setWaiting(false);
        return;
      }
      props.onChanged();
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, props.state.connected]);

  return (
    <div className="card">
      <p className="wf-name" style={{ fontSize: 17 }}>
        Slack
      </p>
      {props.state.connected ? (
        <p className="sentence">
          ✓ Connected{props.state.teamName ? ` — ${props.state.teamName}` : ""}. Message @Liana any time.
        </p>
      ) : (
        <>
          <p className="sentence">
            {waiting
              ? "Waiting for the install to finish in the other tab…"
              : "Add @Liana to your workspace — DM her, or mention her in any thread."}
          </p>
          <div style={{ marginTop: 10 }}>
            <a
              className="btn primary"
              href={`${API_URL}/auth/liana/slack/install`}
              target="_blank"
              rel="noopener"
              onClick={() => setWaiting(true)}
            >
              Add to Slack
            </a>
          </div>
        </>
      )}
    </div>
  );
}

export function IMessageCard(props: {
  state: { phone: string | null; verified: boolean; pendingCode: boolean };
  onChanged: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await action();
      props.onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <p className="wf-name" style={{ fontSize: 17 }}>
        iMessage
      </p>
      {props.state.verified ? (
        <>
          <p className="sentence">✓ Linked — {props.state.phone}. Text Liana like you would a friend; results arrive as texts.</p>
          <div style={{ marginTop: 10 }}>
            <button
              className="btn danger"
              disabled={busy}
              onClick={() => void run(() => api("/api/liana/channels/imessage", { method: "DELETE" }))}
            >
              Unlink
            </button>
          </div>
        </>
      ) : props.state.pendingCode ? (
        <>
          <p className="sentence">We texted a code to {props.state.phone}. Enter it here:</p>
          <div className="field-row" style={{ marginTop: 10 }}>
            <input value={code} placeholder="6-digit code" size={12} inputMode="numeric" onChange={(e) => setCode(e.target.value)} />
            <button
              className="btn primary"
              disabled={busy || code.trim().length < 6}
              onClick={() =>
                void run(() =>
                  api("/api/liana/channels/imessage/verify", { method: "POST", body: JSON.stringify({ code }) }),
                )
              }
            >
              Verify
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => void run(() => api("/api/liana/channels/imessage", { method: "DELETE" }))}
            >
              Different number
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="sentence">Chat with Liana and get workflow results over text. We&apos;ll send a verification code.</p>
          <div className="field-row" style={{ marginTop: 10 }}>
            <input value={phone} placeholder="+1 (555) 123-4567" size={20} inputMode="tel" onChange={(e) => setPhone(e.target.value)} />
            <button
              className="btn primary"
              disabled={busy || phone.trim().length < 10}
              onClick={() =>
                void run(() => api("/api/liana/channels/imessage", { method: "POST", body: JSON.stringify({ phone }) }))
              }
            >
              Text me a code
            </button>
          </div>
        </>
      )}
      {err && <p className="error-note" style={{ marginTop: 8 }}>{err}</p>}
    </div>
  );
}

export function TelegramCard(props: {
  state: { linked: boolean; username: string | null };
  onChanged: () => void;
}) {
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // After opening the t.me link, the bind lands out-of-band (the user presses Start in
  // Telegram) — poll for up to 2 minutes so the card flips without a manual refresh.
  useEffect(() => {
    if (!waiting || props.state.linked) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 120_000) {
        setWaiting(false);
        return;
      }
      props.onChanged();
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, props.state.linked]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await action();
      props.onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <p className="wf-name" style={{ fontSize: 17 }}>
        Telegram
      </p>
      {props.state.linked ? (
        <>
          <p className="sentence">
            ✓ Linked{props.state.username ? ` — @${props.state.username}` : ""}. Message the bot like you would a friend; results arrive in Telegram.
          </p>
          <div style={{ marginTop: 10 }}>
            <button
              className="btn danger"
              disabled={busy}
              onClick={() => void run(() => api("/api/liana/channels/telegram", { method: "DELETE" }))}
            >
              Unlink
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="sentence">
            {waiting
              ? "Waiting for you to press Start in Telegram…"
              : "Chat with Liana and get workflow results in Telegram. One tap — no codes."}
          </p>
          <div style={{ marginTop: 10 }}>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const { url } = await api<{ url: string }>("/api/liana/channels/telegram/start", { method: "POST" });
                  window.open(url, "_blank", "noopener");
                  setWaiting(true);
                })
              }
            >
              {waiting ? "Reopen link" : "Link Telegram"}
            </button>
          </div>
        </>
      )}
      {err && <p className="error-note" style={{ marginTop: 8 }}>{err}</p>}
    </div>
  );
}
