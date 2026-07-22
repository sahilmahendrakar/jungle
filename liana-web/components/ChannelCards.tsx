"use client";

import { useEffect, useState } from "react";
import { api, API_URL, type WireChannels } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import { BrandTile } from "@/components/icons";

// The three ways to talk to Liana, as self-serve cards in a uniform grid: brand tile, name, one
// line, one button. Slack (install), iMessage (verify a phone), Telegram (deep link). Self-
// contained — fetches channel status itself — so both Settings and the home screen drop it in.

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
    <div className="channel-grid">
      <SlackCard state={channels.slack} onChanged={() => void load().then(() => void refreshMe())} />
      {channels.imessage && <IMessageCard state={channels.imessage} onChanged={() => void load()} />}
      {channels.telegram && <TelegramCard state={channels.telegram} onChanged={() => void load()} />}
    </div>
  );
}

// The shell every card shares: brand tile, name, and — when connected — a green status line so the
// three cards line up whatever state they're in.
function CardFrame(props: {
  channel: "slack" | "imessage" | "telegram";
  name: string;
  status?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="channel-card">
      <BrandTile channel={props.channel} />
      <p className="channel-name">{props.name}</p>
      {props.status && <p className="channel-status">{props.status}</p>}
      {props.children}
    </div>
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

  if (props.state.connected) {
    return (
      <CardFrame channel="slack" name="Slack" status={`✓ Connected${props.state.teamName ? ` — ${props.state.teamName}` : ""}`}>
        <p className="channel-line">Message @Liana any time.</p>
      </CardFrame>
    );
  }

  return (
    <CardFrame channel="slack" name="Slack">
      <p className="channel-line">
        {waiting ? "Finishing up in the other tab…" : "DM @Liana or mention her in any thread."}
      </p>
      <a
        className="btn primary channel-btn"
        href={`${API_URL}/auth/liana/slack/install`}
        target="_blank"
        rel="noopener"
        onClick={() => setWaiting(true)}
      >
        Add to Slack
      </a>
    </CardFrame>
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
  // Keep the resting card to a single button; reveal the phone field only when the user opts in,
  // so the three cards stay the same height at rest.
  const [setup, setSetup] = useState(false);

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

  if (props.state.verified) {
    return (
      <CardFrame channel="imessage" name="iMessage" status={`✓ ${props.state.phone}`}>
        <p className="channel-line">Text Liana like a friend; results arrive as texts.</p>
        <button
          className="channel-unlink"
          disabled={busy}
          onClick={() => void run(() => api("/api/liana/channels/imessage", { method: "DELETE" }))}
        >
          Unlink
        </button>
      </CardFrame>
    );
  }

  if (props.state.pendingCode) {
    return (
      <CardFrame channel="imessage" name="iMessage">
        <p className="channel-line">We texted a code to {props.state.phone}.</p>
        <input
          className="channel-input"
          value={code}
          placeholder="6-digit code"
          inputMode="numeric"
          onChange={(e) => setCode(e.target.value)}
        />
        <button
          className="btn primary channel-btn"
          disabled={busy || code.trim().length < 6}
          onClick={() =>
            void run(() => api("/api/liana/channels/imessage/verify", { method: "POST", body: JSON.stringify({ code }) }))
          }
        >
          Verify
        </button>
        <button
          className="channel-unlink"
          disabled={busy}
          onClick={() => void run(() => api("/api/liana/channels/imessage", { method: "DELETE" }))}
        >
          Different number
        </button>
        {err && <p className="error-note channel-err">{err}</p>}
      </CardFrame>
    );
  }

  return (
    <CardFrame channel="imessage" name="iMessage">
      <p className="channel-line">Chat and get results over text.</p>
      {setup ? (
        <>
          <input
            className="channel-input"
            value={phone}
            placeholder="+1 (555) 123-4567"
            inputMode="tel"
            autoFocus
            onChange={(e) => setPhone(e.target.value)}
          />
          <button
            className="btn primary channel-btn"
            disabled={busy || phone.trim().length < 10}
            onClick={() =>
              void run(() => api("/api/liana/channels/imessage", { method: "POST", body: JSON.stringify({ phone }) }))
            }
          >
            Text me a code
          </button>
        </>
      ) : (
        <button className="btn primary channel-btn" onClick={() => setSetup(true)}>
          Set up
        </button>
      )}
      {err && <p className="error-note channel-err">{err}</p>}
    </CardFrame>
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

  if (props.state.linked) {
    return (
      <CardFrame channel="telegram" name="Telegram" status={`✓ Linked${props.state.username ? ` — @${props.state.username}` : ""}`}>
        <p className="channel-line">Message the bot; results arrive in Telegram.</p>
        <button
          className="channel-unlink"
          disabled={busy}
          onClick={() => void run(() => api("/api/liana/channels/telegram", { method: "DELETE" }))}
        >
          Unlink
        </button>
      </CardFrame>
    );
  }

  return (
    <CardFrame channel="telegram" name="Telegram">
      <p className="channel-line">
        {waiting ? "Waiting for you to press Start…" : "One tap — no codes. Chat and get results in Telegram."}
      </p>
      <button
        className="btn primary channel-btn"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const { url } = await api<{ url: string }>("/api/liana/channels/telegram/start", { method: "POST" });
            window.open(url, "_blank", "noopener");
            setWaiting(true);
          })
        }
      >
        {waiting ? "Reopen link" : "Open Telegram"}
      </button>
      {err && <p className="error-note channel-err">{err}</p>}
    </CardFrame>
  );
}
