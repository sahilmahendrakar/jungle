// Tiny client for the Liana backend API. Auth = a signed bearer token minted by the Slack bot
// ("Open in Liana" links carry ?t=<token>); we stash it in localStorage and send it on every call.

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.jungleagents.com";

const TOKEN_KEY = "liana_token";

export function captureTokenFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const t = url.searchParams.get("t");
  if (t) {
    localStorage.setItem(TOKEN_KEY, t);
    url.searchParams.delete("t");
    window.history.replaceState({}, "", url.pathname + url.search);
  }
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
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
  nextRunAt: string | null;
  lastRun: WireRun | null;
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
};
