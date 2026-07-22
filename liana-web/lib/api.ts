// Tiny client for the Liana backend API. Auth = the signed-in user's Firebase ID token,
// fetched fresh per call (the SDK caches and refreshes it under the hood).

import { idToken } from "./firebase";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.jungleagents.com";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await idToken();
  const resp = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    let message = `request failed (${resp.status})`;
    try {
      const body = (await resp.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep default */
    }
    throw new ApiError(resp.status, message);
  }
  return (await resp.json()) as T;
}

// --- Wire types (mirrors backend/src/http/routes/liana.ts) ---

export interface WireMe {
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  teamName: string | null;
  slackConnected: boolean;
}

export interface WireRun {
  id: string;
  status: "running" | "done" | "stalled" | "stopped";
  trigger?: string;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  // Per-channel delivery outcomes, e.g. { slack: "ok", imessage: "failed: …" }. {} until delivered.
  delivery?: Record<string, string>;
}

// One repo option for the GitHub repo picker (GET /api/liana/connections/github/repos).
export interface WireRepo {
  full_name: string; // "owner/name"
  private?: boolean;
}

export interface WireWorkflow {
  id: string;
  name: string;
  status: "draft" | "active" | "paused" | "completed";
  prompt: string;
  // trigger.runAt is an absolute ISO timestamp for one-time ('once') workflows.
  trigger: { type: string; cron?: string; runAt?: string; timezone?: string };
  cadence: string;
  integrations: string[];
  // Per-integration settings for the seat agent, keyed by integration key. `config` holds the
  // user-settable values (repo, requireApproval, …); `connected` = the backing connection is linked.
  integrationSettings?: Record<string, { config: Record<string, unknown>; connected: boolean }>;
  model: string | null; // null on drafts (agent not materialized yet)
  deliverTo: string[]; // "slack" | "imessage" | "telegram"
  // Where runs land now: a human label, whether there's a channel to switch away from, and
  // whether the "send to my DM instead" switch is currently on.
  delivery: { dmOnly: boolean; hasChannel: boolean; label: string };
  nextRunAt: string | null;
  lastRun: WireRun | null;
}

export interface WireChannels {
  channels: {
    slack: { connected: boolean; teamName: string | null };
    // Absent entirely when the deployment has no iMessage provider configured.
    imessage?: { phone: string | null; verified: boolean; pendingCode: boolean };
    // Absent entirely when the deployment has no Telegram bot configured.
    telegram?: { linked: boolean; username: string | null };
  };
}

export interface WireModel {
  id: string;
  label: string;
  hint: string;
}

export interface WireModels {
  models: WireModel[];
  defaults: { liana: string; workflow: string };
}

export interface WireSettings {
  lianaModel: string | null; // null = built-in default
  workflowModel: string | null;
}

export interface WireConnection {
  key: string;
  connected: boolean;
  account: string | null;
}

export const INTEGRATION_LABELS: Record<string, string> = {
  gmail: "Gmail",
  "google-calendar": "Google Calendar",
  "google-drive": "Google Drive",
  github: "GitHub",
  x: "X (Twitter)",
  linear: "Linear",
  notion: "Notion",
  granola: "Granola",
  posthog: "PostHog",
  mixpanel: "Mixpanel",
};

// Which per-integration settings the workflow editor renders — a deliberate small mirror of the
// backend's shared descriptor (liana-web is standalone, no @jungle/shared dep). `repo` = show the
// GitHub repo picker; `approval` = show the "ask me first" toggle with this config key + label.
// Read-only integrations (granola/x/posthog/mixpanel) are absent → their chips have no popover.
export const INTEGRATION_SETTINGS_UI: Record<
  string,
  { repo?: boolean; approval?: { key: "requireSendApproval" | "requireApproval"; label: string } }
> = {
  github: { repo: true },
  gmail: { approval: { key: "requireSendApproval", label: "Ask me before it sends email" } },
  "google-drive": { approval: { key: "requireApproval", label: "Ask me before it changes files in Drive" } },
  "google-calendar": { approval: { key: "requireApproval", label: "Ask me before it changes my calendar" } },
  linear: { approval: { key: "requireApproval", label: "Ask me before it makes changes in Linear" } },
  notion: { approval: { key: "requireApproval", label: "Ask me before it makes changes in Notion" } },
};

// Approval defaults ON: anything that isn't an explicit false means "ask me first".
export function approvalIsOn(value: unknown): boolean {
  return value !== false && value !== "false";
}

// The GitHub repo picker's options. 409 (GitHub not connected) surfaces as an empty list so the
// UI falls back to manual owner/name entry.
export async function fetchGithubRepos(): Promise<WireRepo[]> {
  try {
    const r = await api<{ connected: boolean; repos: WireRepo[] }>("/api/liana/connections/github/repos");
    return r.repos ?? [];
  } catch {
    return [];
  }
}
