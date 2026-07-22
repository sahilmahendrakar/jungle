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
}

export interface WireWorkflow {
  id: string;
  name: string;
  status: "draft" | "active" | "paused";
  prompt: string;
  trigger: { type: string; cron?: string; timezone?: string };
  cadence: string;
  integrations: string[];
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
