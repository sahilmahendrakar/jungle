"use client";

import { useEffect, useState } from "react";
import { api, getToken, type WireModels, type WireSettings } from "@/lib/api";

// Settings: deliberately two decisions, nothing else. Each knob autosaves on change — no
// submit buttons, no dirty state to manage. "Default" is a real option (null server-side), so
// users can always get back to the built-in choice without remembering what it was.

export default function SettingsPage() {
  const [models, setModels] = useState<WireModels | null>(null);
  const [settings, setSettings] = useState<WireSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<"liana" | "workflow" | null>(null);

  useEffect(() => {
    if (!getToken()) {
      setError("Open Liana from Slack first (message @Liana for a link).");
      return;
    }
    Promise.all([api<WireModels>("/api/liana/models"), api<WireSettings>("/api/liana/settings")])
      .then(([m, s]) => {
        setModels(m);
        setSettings(s);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  async function save(field: "lianaModel" | "workflowModel", value: string) {
    if (!settings) return;
    const next = { ...settings, [field]: value || null };
    setSettings(next); // optimistic
    try {
      const saved = await api<WireSettings>("/api/liana/settings", {
        method: "PUT",
        body: JSON.stringify({ [field]: value || null }),
      });
      setSettings(saved);
      setSavedFlash(field === "lianaModel" ? "liana" : "workflow");
      setTimeout(() => setSavedFlash(null), 1500);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error) return <p className="error-note">{error}</p>;
  if (!models || !settings) return <p className="muted">Loading…</p>;

  const labelOf = (id: string) => models.models.find((m) => m.id === id)?.label ?? id;

  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Two things use a model: Liana herself, and your workflows.</p>

      <ModelCard
        title="Liana's model"
        description="What Liana thinks with when you talk to her in Slack — understanding requests and drafting workflows."
        value={settings.lianaModel}
        defaultId={models.defaults.liana}
        defaultLabel={labelOf(models.defaults.liana)}
        models={models}
        saved={savedFlash === "liana"}
        onChange={(v) => void save("lianaModel", v)}
      />

      <ModelCard
        title="New workflows run on"
        description="Applies to workflows you create from now on. Each existing workflow keeps its own model — change it on the workflow's page."
        value={settings.workflowModel}
        defaultId={models.defaults.workflow}
        defaultLabel={labelOf(models.defaults.workflow)}
        models={models}
        saved={savedFlash === "workflow"}
        onChange={(v) => void save("workflowModel", v)}
      />
    </>
  );
}

function ModelCard(props: {
  title: string;
  description: string;
  value: string | null;
  defaultId: string;
  defaultLabel: string;
  models: WireModels;
  saved: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="card">
      <p className="wf-name" style={{ fontSize: 17 }}>
        {props.title}
      </p>
      <p className="sentence" style={{ maxWidth: "34rem" }}>
        {props.description}
      </p>
      <div className="field-row" style={{ marginTop: 14, marginBottom: 0 }}>
        <select
          className="model-select"
          value={props.value ?? ""}
          onChange={(e) => props.onChange(e.target.value)}
        >
          <option value="">{props.defaultLabel} — default</option>
          {props.models.models
            .filter((m) => m.id !== props.defaultId)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.hint}
              </option>
            ))}
        </select>
        <span className="muted" style={{ fontSize: 13, minWidth: 60 }}>
          {props.saved ? "Saved ✓" : ""}
        </span>
      </div>
    </div>
  );
}
