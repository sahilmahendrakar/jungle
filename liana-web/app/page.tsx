"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, INTEGRATION_LABELS, type WireWorkflow } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import { ChannelCards } from "@/components/ChannelCards";
import { capitalize, timeAgo, truncate } from "@/lib/format";

// Home: the workflows list. Cards, not a table — a person has a handful of workflows, and each
// card reads as a sentence: name, cadence, integrations, last-run snippet. First run (no
// workflows yet) doubles as setup: the example ask plus the channel cards.

export default function HomePage() {
  const { status } = useAuth();
  const [workflows, setWorkflows] = useState<WireWorkflow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "ready") return;
    api<{ workflows: WireWorkflow[] }>("/api/liana/workflows")
      .then((r) => setWorkflows(r.workflows))
      .catch((e: Error) => setError(e.message));
  }, [status]);

  if (error) return <p className="error-note">{error}</p>;
  if (!workflows) return <p className="muted">Loading…</p>;
  if (!workflows.length) return <FirstRun />;

  return (
    <>
      <h1 className="page-title">Your workflows</h1>
      <p className="page-sub">Standing instructions that run themselves and land where you talk.</p>
      {workflows.map((wf) => (
        <Link key={wf.id} href={`/w/${wf.id}`} className="card-link">
          <div className="card">
            <p className="wf-name">
              <span className={`dot ${wf.status}`} />
              {wf.name}
            </p>
            <p className="sentence">
              {capitalize(wf.cadence)}
              {wf.integrations.length > 0 && (
                <> · using {wf.integrations.map((k) => INTEGRATION_LABELS[k] ?? k).join(", ")}</>
              )}
              {wf.status === "paused" && <> · paused</>}
              {wf.status === "draft" && <> · draft — confirm it where you asked</>}
            </p>
            {wf.lastRun && (
              <p className="lastrun">
                Last run {timeAgo(wf.lastRun.startedAt)}
                {wf.lastRun.status !== "done" ? ` — ${wf.lastRun.status}` : ""}
                {wf.lastRun.summary ? ` · ${truncate(wf.lastRun.summary, 110)}` : ""}
              </p>
            )}
          </div>
        </Link>
      ))}
    </>
  );
}

function FirstRun() {
  return (
    <>
      <div className="empty" style={{ paddingBottom: 28 }}>
        <div className="big-leaf">🌱</div>
        <h2>Let&apos;s set up your first workflow</h2>
        <p>Connect a place to talk below, then just ask — try:</p>
        <span className="example">&ldquo;Give me a morning briefing every day at 8am&rdquo;</span>
      </div>
      <h2 className="section-title">Where you talk to Liana</h2>
      <ChannelCards />
    </>
  );
}
