"use client";

import { useCallback, useEffect, useState } from "react";
import { api, INTEGRATION_LABELS, type WireConnection } from "@/lib/api";

// Connections: the OAuth grid. Human-language scopes, popup connect for Google/GitHub (the popup
// lands on the shared backend callback, which posts a message and closes itself). A connected card
// can be re-authorized (same popup flow, overwrites the grant in place) or disconnected.

const DESCRIPTIONS: Record<string, string> = {
  gmail: "Can read and search your email. Sending asks first.",
  "google-calendar": "Can see your calendar and events.",
  "google-drive": "Can read files in your Drive.",
  github: "Can read repos and open pull requests.",
  x: "Can read your timeline and mentions. Never posts.",
  linear: "Can read and update your issues.",
  notion: "Can read and edit pages you share.",
  granola: "Can read your meeting notes.",
  posthog: "Can query your product analytics. Read-only.",
  mixpanel: "Can query your product analytics. Read-only.",
  "google-analytics": "Can query your website & app traffic. Read-only.",
};

// Shown under a *connected* card. These are the providers where "connected" doesn't yet mean
// "can see anything" — the grant is real but scoped to whatever you ticked during consent, so a
// silent empty result is usually a too-narrow selection rather than a broken connection.
const REAUTH_HINTS: Record<string, string> = {
  notion: "Notion only shares the pages you tick while connecting. If Liana can't find anything, reconnect and select the pages and databases you want it to reach.",
  "google-drive": "Reconnect if you've added shared drives since you connected.",
  linear: "Reconnect if you've joined a new Linear workspace.",
};

// Every key connects via popup OAuth (Google/GitHub identity flows or the adapters' own
// MCP-OAuth / OAuth start — PostHog, Mixpanel and Google Analytics included).
const OAUTH_CONNECTABLE = new Set([
  "gmail",
  "google-calendar",
  "google-drive",
  "github",
  "x",
  "linear",
  "notion",
  "granola",
  "posthog",
  "mixpanel",
  "google-analytics",
]);

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<WireConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which card has a flow in flight, and which is asking "really disconnect?".
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ connections: WireConnection[] }>("/api/liana/connections")
      .then((r) => setConnections(r.connections))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    // The OAuth popup posts {connection, status} via postMessage when it closes.
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as { connection?: string; status?: string };
      if (d?.connection && d?.status) {
        setBusy(null);
        load();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [load]);

  // Connect and reconnect are the same flow: the callback upserts the grant, so re-consenting
  // replaces the old one (and clears needs_reconnect) without a gap where nothing is connected.
  async function connect(key: string) {
    setError(null);
    setBusy(key);
    try {
      const { url } = await api<{ url: string }>(`/api/liana/connections/${key}/start`, {
        method: "POST",
        body: "{}",
      });
      const popup = window.open(url, "liana-oauth", "width=560,height=720");
      if (!popup) throw new Error("your browser blocked the popup — allow popups for this site and try again");
      // Fall back to polling: some providers sever window.opener, so the postMessage never lands.
      // Give up after 5 minutes rather than leaving an interval running on an abandoned consent.
      const deadline = Date.now() + 5 * 60 * 1000;
      const poll = setInterval(() => {
        if (!popup.closed && Date.now() < deadline) return;
        clearInterval(poll);
        setBusy(null);
        load();
      }, 800);
    } catch (e) {
      setBusy(null);
      setError((e as Error).message);
    }
  }

  async function disconnect(key: string) {
    setError(null);
    setBusy(key);
    setConfirming(null);
    try {
      await api(`/api/liana/connections/${key}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (error && !connections) return <p className="error-note">{error}</p>;
  if (!connections) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1 className="page-title">Connections</h1>
      <p className="page-sub">What your workflows are allowed to reach. Connect only what you use.</p>
      {error && <p className="error-note">{error}</p>}
      <div className="conn-grid">
        {connections.map((c) => {
          const label = INTEGRATION_LABELS[c.key] ?? c.key;
          const working = busy === c.key;
          const linked = c.connected || c.needsReconnect;
          return (
            <div key={c.key} className="conn">
              <div className="conn-name">{label}</div>
              <div className="conn-sub">
                {c.needsReconnect
                  ? `${label} stopped accepting the saved sign-in. Reconnect to fix it.`
                  : c.connected
                    ? `Connected${c.account ? ` as ${c.account}` : ""}`
                    : (DESCRIPTIONS[c.key] ?? "")}
              </div>

              {linked ? (
                <>
                  {/* The account already reads in conn-sub above — keep the chip to the state
                      alone so a long workspace name can't wrap the pill across two lines. */}
                  <span className={c.needsReconnect ? "chip warn" : "chip"}>
                    {c.needsReconnect ? "⚠ Reconnect needed" : "✓ Connected"}
                  </span>
                  {confirming === c.key ? (
                    <div className="conn-actions">
                      <span className="conn-confirm">Disconnect {label}?</span>
                      <button className="btn danger small" disabled={working} onClick={() => void disconnect(c.key)}>
                        {working ? "Disconnecting…" : "Yes, disconnect"}
                      </button>
                      <button className="btn small" disabled={working} onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="conn-actions">
                      <button
                        className={`btn small${c.needsReconnect ? " primary" : ""}`}
                        disabled={working}
                        onClick={() => void connect(c.key)}
                      >
                        {working ? "Waiting…" : "Reconnect"}
                      </button>
                      <button className="btn small danger" disabled={working} onClick={() => setConfirming(c.key)}>
                        Disconnect
                      </button>
                    </div>
                  )}
                  {c.connected && REAUTH_HINTS[c.key] && <p className="conn-hint">{REAUTH_HINTS[c.key]}</p>}
                </>
              ) : OAUTH_CONNECTABLE.has(c.key) ? (
                <button className="btn" disabled={working} onClick={() => void connect(c.key)}>
                  {working ? "Waiting…" : "Connect"}
                </button>
              ) : (
                <span className="muted" style={{ fontSize: 13 }}>
                  Coming soon
                </span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
