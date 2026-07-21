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
            Slack DM
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
        </span>
      </div>

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
