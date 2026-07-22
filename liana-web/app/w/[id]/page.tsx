"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import ScheduleEditor from "@/components/ScheduleEditor";
import { api, INTEGRATION_LABELS, type WireChannels, type WireConnection, type WireModels, type WireRun, type WireWorkflow } from "@/lib/api";
import { capitalize, timeAgo } from "@/lib/format";

// Workflow detail: the prompt as editable prose (the centerpiece), the cadence as a sentence,
// integrations with connect state, run-now, and the run history as a stem of nodes.

export default function WorkflowPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [wf, setWf] = useState<WireWorkflow | null>(null);
  const [runs, setRuns] = useState<WireRun[]>([]);
  const [connections, setConnections] = useState<WireConnection[]>([]);
  const [models, setModels] = useState<WireModels | null>(null);
  const [channels, setChannels] = useState<WireChannels["channels"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [runningNow, setRunningNow] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ workflow: WireWorkflow; runs: WireRun[] }>(`/api/liana/workflows/${id}`);
      setWf(r.workflow);
      setRuns(r.runs);
      const c = await api<{ connections: WireConnection[] }>(`/api/liana/connections`);
      setConnections(c.connections);
      setModels(await api<WireModels>(`/api/liana/models`));
      setChannels((await api<WireChannels>(`/api/liana/channels`)).channels);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
    // The OAuth popup posts {connection, status} via postMessage when it closes.
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as { connection?: string; status?: string };
      if (d?.connection && d?.status) void load();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [load]);

  async function patch(body: Record<string, unknown>) {
    setSaving("saving");
    try {
      const r = await api<{ workflow: WireWorkflow }>(`/api/liana/workflows/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setWf(r.workflow);
      setSaving("saved");
      setTimeout(() => setSaving("idle"), 1500);
    } catch (e) {
      setError((e as Error).message);
      setSaving("idle");
    }
  }

  async function runNow() {
    setRunningNow(true);
    try {
      await api(`/api/liana/workflows/${id}/run`, { method: "POST", body: "{}" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunningNow(false);
    }
  }

  async function toggleIntegration(key: string) {
    if (!wf) return;
    const had = wf.integrations.includes(key);
    const next = had ? wf.integrations.filter((k) => k !== key) : [...wf.integrations, key];
    await patch({ integrations: next });
    // Adding something not yet connected? Launch the OAuth popup right away instead of leaving
    // an unconnected chip pointing at the Connections page.
    if (!had && !connections.find((c) => c.key === key)?.connected) {
      try {
        const { url } = await api<{ url: string }>(`/api/liana/connections/${key}/start`, { method: "POST", body: "{}" });
        window.open(url, "liana-oauth", "width=560,height=720");
      } catch (e) {
        setError((e as Error).message);
      }
    }
  }

  async function remove() {
    if (!confirm(`Delete “${wf?.name}”? Its history goes with it.`)) return;
    await api(`/api/liana/workflows/${id}`, { method: "DELETE" });
    router.push("/");
  }

  if (error) return <p className="error-note">{error}</p>;
  if (!wf) return <p className="muted">Loading…</p>;

  const connByKey = new Map(connections.map((c) => [c.key, c]));

  return (
    <>
      <h1 className="page-title">
        <span className={`dot ${wf.status}`} style={{ marginRight: 12 }} />
        {wf.name}
      </h1>
      <p className="page-sub">
        {capitalize(wf.cadence)}
        {wf.nextRunAt && wf.status === "active" ? ` · next run ${new Date(wf.nextRunAt).toLocaleString()}` : ""}
        {wf.status === "paused" ? " · paused" : ""}
        {wf.status === "draft" ? " · draft — confirm it in Slack first" : ""}
      </p>

      <div className="prompt-frame">
        <textarea
          ref={promptRef}
          className="prompt-editor"
          defaultValue={wf.prompt}
          spellCheck={false}
          onBlur={(e) => {
            if (e.target.value.trim() && e.target.value !== wf.prompt) {
              void patch({ prompt: e.target.value });
            }
          }}
        />
        <div className="prompt-meta">
          <span>{saving === "saving" ? "Saving…" : saving === "saved" ? "Saved ✓" : "The standing instruction — click to edit; saves when you click away."}</span>
        </div>
      </div>

      <div className="chips">
        {wf.integrations.map((k) => {
          const c = connByKey.get(k);
          const ok = c?.connected;
          return (
            <span key={k} className={`chip ${ok ? "" : "unconnected"}`} title={ok ? `Connected${c?.account ? ` as ${c.account}` : ""}` : "Not connected — visit Connections"}>
              {ok ? "✓" : "•"} {INTEGRATION_LABELS[k] ?? k}
            </span>
          );
        })}
        <span style={{ position: "relative" }}>
          <button className="chip chip-add" onClick={() => setPickerOpen((v) => !v)} aria-label="Add integration" title="Add integration">
            +
          </button>
          {pickerOpen && (
            <>
              <div className="chip-menu-backdrop" onClick={() => setPickerOpen(false)} />
              <div className="chip-menu">
                {connections.map((c) => {
                  const on = wf.integrations.includes(c.key);
                  return (
                    <button key={c.key} className="chip-menu-item" onClick={() => void toggleIntegration(c.key)}>
                      <span className="chip-menu-tick">{on ? "✓" : ""}</span>
                      {INTEGRATION_LABELS[c.key] ?? c.key}
                      {!c.connected && <span className="chip-menu-hint">not connected</span>}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </span>
      </div>

      <div className="field-row" style={{ marginTop: 22, alignItems: "flex-start" }}>
        <label style={{ paddingTop: 8 }}>Schedule</label>
        <ScheduleEditor
          key={`${wf.trigger.type}:${wf.trigger.cron ?? ""}:${wf.trigger.timezone ?? ""}`}
          cron={wf.trigger.type === "schedule" ? (wf.trigger.cron ?? null) : null}
          timezone={wf.trigger.type === "schedule" ? (wf.trigger.timezone ?? null) : null}
          onSave={(cron, timezone) => void patch(cron === null ? { cron: null } : { cron, timezone })}
        />
      </div>

      <div className="field-row">
        <label>Delivers to</label>
        <span style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <label className="check-chip">
            <input
              type="checkbox"
              checked={wf.deliverTo.includes("slack")}
              onChange={(e) => {
                const next = e.target.checked
                  ? [...new Set([...wf.deliverTo, "slack"])]
                  : wf.deliverTo.filter((c) => c !== "slack");
                if (next.length) void patch({ deliverTo: next });
              }}
            />
            Slack
          </label>
          {channels?.imessage &&
            (channels.imessage.verified ? (
              <label className="check-chip">
                <input
                  type="checkbox"
                  checked={wf.deliverTo.includes("imessage")}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...new Set([...wf.deliverTo, "imessage"])]
                      : wf.deliverTo.filter((c) => c !== "imessage");
                    if (next.length) void patch({ deliverTo: next });
                  }}
                />
                iMessage
              </label>
            ) : (
              <span className="muted" style={{ fontSize: 13 }}>
                iMessage — <Link href="/settings">verify your number first</Link>
              </span>
            ))}
          {channels?.telegram &&
            (channels.telegram.linked ? (
              <label className="check-chip">
                <input
                  type="checkbox"
                  checked={wf.deliverTo.includes("telegram")}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...new Set([...wf.deliverTo, "telegram"])]
                      : wf.deliverTo.filter((c) => c !== "telegram");
                    if (next.length) void patch({ deliverTo: next });
                  }}
                />
                Telegram
              </label>
            ) : (
              <span className="muted" style={{ fontSize: 13 }}>
                Telegram — <Link href="/settings">link your account first</Link>
              </span>
            ))}
        </span>
      </div>

      {/* Where within the surface: the channel Liana was invoked in, or the owner's DM. Only shown
          when there's a channel to switch away from — a DM-only workflow needs no control. */}
      {wf.delivery.hasChannel && (
        <div className="field-row">
          <label>Where</label>
          <span style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <span className="muted" style={{ fontSize: 13 }}>
              Runs post to <strong>{wf.delivery.label}</strong>
            </span>
            <label className="check-chip">
              <input
                type="checkbox"
                checked={wf.delivery.dmOnly}
                onChange={(e) => void patch({ dmOnly: e.target.checked })}
              />
              Send to my DM instead
            </label>
          </span>
        </div>
      )}

      {models && wf.status !== "draft" && (
        <div className="field-row">
          <label>Model</label>
          <select
            value={wf.model ?? ""}
            onChange={(e) => {
              if (e.target.value) void patch({ model: e.target.value });
            }}
          >
            {wf.model === null && <option value="">Default</option>}
            {models.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.hint}
              </option>
            ))}
          </select>
          <span className="muted" style={{ fontSize: 13 }}>
            Takes effect from the next run.
          </span>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
        <button className="btn primary" onClick={() => void runNow()} disabled={runningNow || wf.status === "draft"}>
          {runningNow ? "Starting…" : "Run now"}
        </button>
        {wf.status !== "draft" && (
          <button className="btn" onClick={() => void patch({ paused: wf.status !== "paused" })}>
            {wf.status === "paused" ? "Resume" : "Pause"}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn danger" onClick={() => void remove()}>
          Delete
        </button>
      </div>

      <h2 className="section-title">Runs</h2>
      {runs.length === 0 && <p className="muted">No runs yet.</p>}
      <div className="runs">
        {runs.map((r) => (
          <RunNode key={r.id} workflowId={wf.id} run={r} />
        ))}
      </div>
    </>
  );
}

function RunNode({ workflowId, run }: { workflowId: string; run: WireRun }) {
  const [open, setOpen] = useState(false);
  const [output, setOutput] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && output === null) {
      try {
        const r = await api<{ output: string }>(`/api/liana/workflows/${workflowId}/runs/${run.id}`);
        setOutput(r.output);
      } catch (e) {
        setOutput(`Couldn't load output: ${(e as Error).message}`);
      }
    }
  }

  const cls = run.status === "done" ? "" : run.status === "running" ? "running" : "failed";
  return (
    <div className={`run ${cls}`}>
      <div className="run-head" onClick={() => void toggle()}>
        <span className="run-when">{timeAgo(run.startedAt)}</span>
        <span className="run-status">
          {run.status}
          {run.summary ? ` · ${run.summary}` : ""}
        </span>
      </div>
      {open && <div className="run-output">{output ?? "Loading…"}</div>}
    </div>
  );
}
