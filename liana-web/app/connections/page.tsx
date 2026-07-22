"use client";

import { useCallback, useEffect, useState } from "react";
import { api, INTEGRATION_LABELS, type WireConnection } from "@/lib/api";

// Connections: the OAuth grid. Human-language scopes, popup connect for Google/GitHub (the popup
// lands on the shared backend callback, which posts a message and closes itself).

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
};

// Every key connects via popup OAuth (Google/GitHub identity flows or the adapters' own
// MCP-OAuth start — PostHog and Mixpanel included).
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
]);

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<WireConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      if (d?.connection && d?.status) load();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [load]);

  async function connect(key: string) {
    try {
      const { url } = await api<{ url: string }>(`/api/liana/connections/${key}/start`, {
        method: "POST",
        body: "{}",
      });
      window.open(url, "liana-oauth", "width=560,height=720");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error) return <p className="error-note">{error}</p>;
  if (!connections) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1 className="page-title">Connections</h1>
      <p className="page-sub">What your workflows are allowed to reach. Connect only what you use.</p>
      <div className="conn-grid">
        {connections.map((c) => (
          <div key={c.key} className="conn">
            <div className="conn-name">{INTEGRATION_LABELS[c.key] ?? c.key}</div>
            <div className="conn-sub">
              {c.connected ? `Connected${c.account ? ` as ${c.account}` : ""}` : (DESCRIPTIONS[c.key] ?? "")}
            </div>
            {c.connected ? (
              <span className="chip">✓ Connected{c.account ? ` — ${c.account}` : ""}</span>
            ) : OAUTH_CONNECTABLE.has(c.key) ? (
              <button className="btn" onClick={() => void connect(c.key)}>
                Connect
              </button>
            ) : (
              <span className="muted" style={{ fontSize: 13 }}>
                Coming soon
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
