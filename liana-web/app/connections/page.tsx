"use client";

import { useCallback, useEffect, useState } from "react";
import { api, getToken, INTEGRATION_LABELS, type WireConnection } from "@/lib/api";

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

// OAuth keys connect via popup (Google/GitHub identity flows or the adapters' own OAuth start).
const OAUTH_CONNECTABLE = new Set([
  "gmail",
  "google-calendar",
  "google-drive",
  "github",
  "x",
  "linear",
  "notion",
  "granola",
]);

// Static-credential keys connect with a small inline form (no OAuth for headless use).
const APIKEY_FIELDS: Record<string, { key: string; label: string; secret?: boolean }[]> = {
  posthog: [{ key: "apiKey", label: "Personal API key (phx_…)", secret: true }],
  mixpanel: [
    { key: "username", label: "Service account username" },
    { key: "secret", label: "Service account secret", secret: true },
  ],
};

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<WireConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!getToken()) {
      setError("Open Liana from Slack first (message @Liana for a link).");
      return;
    }
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
            ) : APIKEY_FIELDS[c.key] ? (
              <ApiKeyConnect integrationKey={c.key} fields={APIKEY_FIELDS[c.key]} onConnected={load} />
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

// Inline paste-key connect: collapsed to a Connect button; expands to the provider's one or two
// credential fields, validates server-side, and collapses back on success.
function ApiKeyConnect(props: {
  integrationKey: string;
  fields: { key: string; label: string; secret?: boolean }[];
  onConnected: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        Connect
      </button>
    );
  }
  const ready = props.fields.every((f) => (values[f.key] ?? "").trim());
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {props.fields.map((f) => (
        <input
          key={f.key}
          type={f.secret ? "password" : "text"}
          placeholder={f.label}
          value={values[f.key] ?? ""}
          style={{ fontSize: 13.5, padding: "7px 10px", border: "1px solid var(--hairline)", borderRadius: 8, background: "var(--card)" }}
          onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
        />
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className="btn primary"
          disabled={busy || !ready}
          onClick={() => {
            setBusy(true);
            setErr(null);
            api(`/api/liana/connections/${props.integrationKey}/apikey`, {
              method: "POST",
              body: JSON.stringify(values),
            })
              .then(() => {
                setOpen(false);
                props.onConnected();
              })
              .catch((e: Error) => setErr(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Checking…" : "Save"}
        </button>
        <button className="btn" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {err && <span className="error-note" style={{ fontSize: 13 }}>{err}</span>}
    </div>
  );
}
