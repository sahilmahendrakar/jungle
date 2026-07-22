"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, INTEGRATION_LABELS, type WireWorkflow } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import { capitalize, countdown, friendlyDate, timeAgo, truncate } from "@/lib/format";

// The workflows list. Cards, not a table — a person has a handful of workflows, and each card
// reads as a sentence: name, cadence, integrations, last-run snippet. Grouped so one-time
// workflows read right: what's live, what's coming up once, and what's already done. Channel
// setup lives on Home, so with no workflows this page just points you back to a chat surface.

export default function WorkflowsPage() {
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
  if (!workflows.length) {
    return (
      <div className="empty" style={{ paddingBottom: 28 }}>
        <div className="big-leaf">🌿</div>
        <h2>No workflows yet</h2>
        <p>Just ask Liana in Slack, iMessage, or Telegram — she&apos;ll set it up and it&apos;ll show up here.</p>
        <Link className="btn" href="/">
          Connect a channel
        </Link>
      </div>
    );
  }

  // A one-time workflow that hasn't fired is "upcoming"; a fired one is "done". Recurring and
  // on-demand (plus in-progress drafts) are the standing set.
  const upcoming = workflows.filter((w) => w.trigger.type === "once" && w.status === "active");
  const done = workflows.filter((w) => w.status === "completed");
  const standing = workflows.filter((w) => !upcoming.includes(w) && !done.includes(w));
  const multi = [standing, upcoming, done].filter((g) => g.length).length > 1;

  return (
    <>
      <h1 className="page-title">Your workflows</h1>
      <p className="page-sub">Standing instructions that run themselves and land where you talk.</p>
      <Group title={multi ? "Active" : null} items={standing} />
      <Group title="Coming up once" items={upcoming} />
      <Group title="Done" items={done} muted />
    </>
  );
}

function Group({ title, items, muted }: { title: string | null; items: WireWorkflow[]; muted?: boolean }) {
  if (!items.length) return null;
  return (
    <>
      {title && <h2 className="section-title">{title}</h2>}
      {items.map((wf) => (
        <WorkflowCard key={wf.id} wf={wf} muted={muted} />
      ))}
    </>
  );
}

function WorkflowCard({ wf, muted }: { wf: WireWorkflow; muted?: boolean }) {
  const isOnce = wf.trigger.type === "once";
  const soon = isOnce && wf.status === "active" && wf.nextRunAt ? countdown(wf.nextRunAt) : "";
  return (
    <Link href={`/w/${wf.id}`} className="card-link">
      <div className={`card${muted ? " card-done" : ""}`}>
        <p className="wf-name">
          <span className={`dot ${wf.status}`} />
          {wf.name}
          {soon && <span className="pill-when">{soon}</span>}
        </p>
        <p className="sentence">
          {wf.status === "completed" && wf.lastRun
            ? `Ran once · ${friendlyDate(wf.lastRun.endedAt ?? wf.lastRun.startedAt)}`
            : capitalize(wf.cadence)}
          {wf.integrations.length > 0 && (
            <> · using {wf.integrations.map((k) => INTEGRATION_LABELS[k] ?? k).join(", ")}</>
          )}
          {wf.status === "paused" && <> · paused</>}
          {wf.status === "draft" && <> · draft — confirm it where you asked</>}
        </p>
        {wf.status !== "completed" && wf.lastRun && (
          <p className="lastrun">
            Last run {timeAgo(wf.lastRun.startedAt)}
            {wf.lastRun.status !== "done" ? ` — ${wf.lastRun.status}` : ""}
            {wf.lastRun.summary ? ` · ${truncate(wf.lastRun.summary, 110)}` : ""}
          </p>
        )}
      </div>
    </Link>
  );
}
