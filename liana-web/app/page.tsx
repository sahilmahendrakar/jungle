"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  api,
  API_URL,
  captureTokenFromUrl,
  getToken,
  INTEGRATION_LABELS,
  type WireWorkflow,
} from "@/lib/api";
import { capitalize, timeAgo, truncate } from "@/lib/format";

// Home: the workflows list. Cards, not a table — a person has a handful of workflows, and each
// card reads as a sentence: name, cadence, integrations, last-run snippet.

export default function HomePage() {
  const [workflows, setWorkflows] = useState<WireWorkflow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noToken, setNoToken] = useState(false);

  useEffect(() => {
    captureTokenFromUrl();
    if (!getToken()) {
      setNoToken(true);
      return;
    }
    api<{ workflows: WireWorkflow[] }>("/api/liana/workflows")
      .then((r) => setWorkflows(r.workflows))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (noToken) return <SignedOut />;
  if (error) return <p className="error-note">{error}</p>;
  if (!workflows) return <p className="muted">Loading…</p>;
  if (!workflows.length) return <NoWorkflows />;

  return (
    <>
      <h1 className="page-title">Your workflows</h1>
      <p className="page-sub">Standing instructions that run themselves and land in your Slack DMs.</p>
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
              {wf.status === "draft" && <> · draft — confirm it in Slack</>}
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

function SignedOut() {
  return (
    <div className="empty">
      <div className="big-leaf">🌿</div>
      <h2>Liana lives in Slack</h2>
      <p>
        Open Liana from a link the bot sends you (message <b>@Liana</b> and ask for your workflows), or install
        it to your Slack workspace.
      </p>
      <a className="btn primary" href={`${API_URL}/auth/liana/slack/install`}>
        Add to Slack
      </a>
    </div>
  );
}

function NoWorkflows() {
  return (
    <div className="empty">
      <div className="big-leaf">🌱</div>
      <h2>No workflows yet</h2>
      <p>Ask in Slack and it happens — try messaging @Liana:</p>
      <span className="example">“Give me a morning briefing every day at 8am”</span>
    </div>
  );
}

