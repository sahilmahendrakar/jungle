"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type WireWorkflow } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import { ChannelCards } from "@/components/ChannelCards";
import { timeAgo, truncate } from "@/lib/format";

// Home: the front door once you're signed in. First job is getting you talking to Liana, so the
// channel cards lead. If nothing's connected or created yet, that's the whole page (plus an
// example ask). Once workflows are running, a brief "Lately" glance shows what she's been up to;
// the full, detailed list lives on the Workflows page.

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

  // No workflows yet → channel-first welcome. (Still loading also shows this scaffold, so the
  // channel cards — which fetch their own status — appear immediately rather than after a spinner.)
  if (!workflows || !workflows.length) {
    return (
      <>
        <div className="home-hero">
          <div className="big-leaf">🌱</div>
          <h1>Pick where you&apos;ll talk to Liana</h1>
          <p>She works wherever you already chat — connect one and just ask.</p>
        </div>
        <ChannelCards />
        <div className="home-asks">
          <p className="home-asks-label">Then just ask:</p>
          <span className="example">&ldquo;Give me a morning briefing every day at 8am&rdquo;</span>
          <span className="example">&ldquo;Remind me to send the report next Monday at 9am&rdquo;</span>
        </div>
      </>
    );
  }

  // One row per workflow's most-recent run, newest first — a daily workflow shouldn't crowd out
  // everything else, so we glance at the latest run of each rather than a raw run feed.
  const lately = workflows
    .filter((w) => w.lastRun)
    .sort((a, b) => (b.lastRun!.startedAt < a.lastRun!.startedAt ? -1 : 1))
    .slice(0, 6);

  return (
    <>
      <h1 className="page-title">Welcome back</h1>
      <p className="page-sub">Where you talk to Liana, and what she&apos;s been up to.</p>

      <h2 className="section-title" style={{ marginTop: 8 }}>
        Channels
      </h2>
      <ChannelCards />

      {lately.length > 0 && (
        <>
          <h2 className="section-title">Lately</h2>
          <div className="lately">
            {lately.map((wf) => (
              <Link key={wf.id} href={`/w/${wf.id}`} className="lately-row">
                <span className={`dot ${wf.lastRun!.status === "running" ? "active" : wf.status}`} />
                <span className="lately-name">{wf.name}</span>
                <span className="lately-meta">
                  {timeAgo(wf.lastRun!.startedAt)}
                  {wf.lastRun!.summary ? ` · ${truncate(wf.lastRun!.summary, 80)}` : ""}
                </span>
              </Link>
            ))}
          </div>
          <Link className="lately-all" href="/workflows">
            All workflows →
          </Link>
        </>
      )}
    </>
  );
}
