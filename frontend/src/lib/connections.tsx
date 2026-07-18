// Unified per-user connections: one view-model + UI kit over the three OAuth families
// (GitHub, Google, remote-MCP integrations). Every integration is built on a connection
// (@jungle/shared CONNECTION_TYPES); this module gives Settings and the integrations editor
// the same brand icons, live statuses, and a popup connect flow that doesn't lose SPA state
// (e.g. an in-progress create-agent draft).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CONNECTION_TYPES,
  type ConnectionType,
  type GithubStatus,
  type GoogleStatus,
  type IntegrationStatuses,
  disconnectGithub,
  disconnectGoogle,
  disconnectIntegration,
  getGithubStatus,
  getGoogleStatus,
  getIntegrationStatuses,
  githubConnectUrl,
  googleConnectUrl,
  integrationConnectUrl,
} from "../api";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Brand marks (official monochrome glyphs, paths from simple-icons; Granola has no published
// mark, so it gets a neutral "notes" glyph). Rendered inside a consistent rounded tile.

const BRAND_PATHS: Record<string, string> = {
  github:
    "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  google:
    "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z",
  gmail:
    "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z",
  linear:
    "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
  notion:
    "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
  "google-drive":
    "M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z",
  // Google Calendar: simple calendar-page glyph (hand-authored in the granola style — no
  // official mark in simple-icons). Ring page + binder tabs + two event lines.
  "google-calendar":
    "M5 4.5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1zM6 6.5v12h12v-12H6zM7.5 1.5h1.5v4h-1.5zM15 1.5h1.5v4h-1.5zM8 10h8a.75.75 0 0 1 0 1.5H8a.75.75 0 0 1 0-1.5zM8 14h5a.75.75 0 0 1 0 1.5H8a.75.75 0 0 1 0-1.5z",
  // Granola: simple meeting-notes glyph (no official mark in simple-icons).
  granola:
    "M5 2.5h14a1 1 0 0 1 1 1v17a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1zm2.5 4.75a.75.75 0 0 0 0 1.5h9a.75.75 0 0 0 0-1.5zm0 4a.75.75 0 0 0 0 1.5h9a.75.75 0 0 0 0-1.5zm0 4a.75.75 0 0 0 0 1.5h5.5a.75.75 0 0 0 0-1.5z",
  slack:
    "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
  // X (formerly Twitter): official monochrome mark — black in light mode, white in dark.
  x:
    "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
};

// Brand accent per connection/integration key, used for the glyph on a neutral tile so the
// tiles stay consistent in light & dark mode.
const BRAND_COLORS: Record<string, string> = {
  github: "", // uses text-foreground (GitHub's mark is black/white)
  google: "#4285F4",
  gmail: "#EA4335",
  linear: "#5E6AD2",
  notion: "", // black/white mark
  "google-drive": "#34A853",
  "google-calendar": "#4285F4",
  granola: "#D97706",
  x: "", // black/white mark — uses text-foreground
};

// The raw brand glyph (an SVG path on a 24×24 viewBox).
export function BrandGlyph({ brand, className }: { brand: string; className?: string }) {
  const path = BRAND_PATHS[brand] ?? BRAND_PATHS.granola;
  const color = BRAND_COLORS[brand];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("shrink-0", !color && "text-foreground", className)}
      style={color ? { color } : undefined}
      aria-hidden
    >
      <path d={path} />
    </svg>
  );
}

// The standard tile: neutral rounded square + brand-colored glyph. `size` is the tailwind
// size of the tile (the glyph scales with it).
export function BrandTile({
  brand,
  className,
  glyphClassName,
}: {
  brand: string;
  className?: string;
  glyphClassName?: string;
}) {
  return (
    <div
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background",
        className,
      )}
    >
      <BrandGlyph brand={brand} className={cn("size-4", glyphClassName)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unified live state

export interface ConnectionState extends ConnectionType {
  connected: boolean;
  // Display handle of the linked account (@login / email / workspace name), when known.
  account?: string | null;
  // The stored OAuth grant is dead (invalid_grant) — only a fresh consent revives it.
  // Rendered as an amber "Reconnect needed" state; the connect flow IS the reconnect flow.
  needsReconnect?: boolean;
  // Extra GitHub detail (App installations / repo count) for the Settings expansion.
  github?: GithubStatus | null;
}

export interface ConnectionsApi {
  connections: ConnectionState[];
  byKey: Record<string, ConnectionState>;
  loading: boolean;
  // Which connection key currently has a connect flow in flight (popup open), if any.
  connecting: string | null;
  error: string;
  refresh: () => Promise<void>;
  // Run the connect flow for a connection in a popup. Resolves once the flow finishes
  // (statuses already refreshed); true = now connected.
  connect: (key: string) => Promise<boolean>;
  disconnect: (key: string) => Promise<void>;
}

function assemble(
  gh: GithubStatus | null,
  google: GoogleStatus | null,
  ints: IntegrationStatuses,
): ConnectionState[] {
  return CONNECTION_TYPES.map((c) => {
    if (c.kind === "github") {
      return { ...c, connected: gh?.connected ?? false, account: gh?.login ? `@${gh.login}` : null, github: gh };
    }
    if (c.kind === "google") {
      return {
        ...c,
        connected: google?.connected ?? false,
        account: google?.email ?? null,
        needsReconnect: google?.needsReconnect ?? false,
      };
    }
    const st = ints[c.key];
    return {
      ...c,
      connected: st?.connected ?? false,
      account: st?.externalAccount ?? null,
      needsReconnect: st?.needsReconnect ?? false,
    };
  });
}

async function fetchAll(): Promise<[GithubStatus | null, GoogleStatus | null, IntegrationStatuses]> {
  // Each family fails independently (e.g. dev-bypass mode has no GitHub/Google auth routes) —
  // a failed fetch just renders as "not connected" rather than breaking the whole list.
  return Promise.all([
    getGithubStatus().catch(() => null),
    getGoogleStatus().catch(() => null),
    getIntegrationStatuses().catch(() => ({}) as IntegrationStatuses),
  ]);
}

function connectUrlFor(key: string, popup: boolean): Promise<{ url: string }> {
  const c = CONNECTION_TYPES.find((t) => t.key === key);
  if (!c) return Promise.reject(new Error(`unknown connection: ${key}`));
  if (c.kind === "github") return githubConnectUrl({ popup });
  if (c.kind === "google") return googleConnectUrl({ popup });
  return integrationConnectUrl(key, { popup });
}

function disconnectFor(key: string): Promise<unknown> {
  const c = CONNECTION_TYPES.find((t) => t.key === key);
  if (!c) return Promise.reject(new Error(`unknown connection: ${key}`));
  if (c.kind === "github") return disconnectGithub();
  if (c.kind === "google") return disconnectGoogle();
  return disconnectIntegration(key);
}

// Run one OAuth flow in a popup and resolve when it finishes. Completion is detected two ways,
// because providers differ: (1) the callback's self-closing page postMessages us — instant, but
// COOP on some providers (Google) severs window.opener so it can't be relied on; (2) we poll
// `isConnected` every few seconds as ground truth. If the popup closes without either, a short
// grace poll catches "the page closed before its message arrived", then we give up quietly.
async function runPopupFlow(key: string, isConnected: () => Promise<boolean>): Promise<boolean> {
  const { url } = await connectUrlFor(key, true);
  const popup = window.open(url, `jungle-connect-${key}`, "width=560,height=720");
  if (!popup) {
    // Popup blocked — fall back to the classic full-page redirect flow.
    const { url: redirectUrl } = await connectUrlFor(key, false);
    window.location.href = redirectUrl;
    return false;
  }
  const TIMEOUT_MS = 5 * 60 * 1000;
  const POLL_MS = 3000;
  const start = Date.now();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      if (pollTimer) clearTimeout(pollTimer);
      try {
        if (!popup.closed) popup.close();
      } catch {
        /* COOP-severed handle; the page closes itself */
      }
      resolve(ok);
    };
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { source?: string; connection?: string; status?: string } | null;
      if (d && d.source === "jungle-oauth" && d.connection === key) finish(d.status === "connected");
    };
    window.addEventListener("message", onMessage);
    let closedPolls = 0; // extra polls granted after the popup closed
    const poll = async () => {
      if (settled) return;
      try {
        if (await isConnected()) return finish(true);
      } catch {
        /* transient status failure — keep polling */
      }
      if (settled) return;
      let closed = false;
      try {
        closed = popup.closed;
      } catch {
        closed = true;
      }
      // `popup.closed` also flips true when a COOP provider severs the handle, so a closed
      // popup gets a couple of grace polls instead of an instant failure.
      if (closed && ++closedPolls > 2) return finish(false);
      if (Date.now() - start > TIMEOUT_MS) return finish(false);
      pollTimer = setTimeout(poll, closed ? 1200 : POLL_MS);
    };
    pollTimer = setTimeout(poll, 1500);
  });
}

// The one hook both Settings and the integrations editor use. Fetches all connection statuses,
// and exposes popup-based connect + disconnect that keep the statuses fresh.
export function useConnections(enabled = true): ConnectionsApi {
  const [state, setState] = useState<ConnectionState[]>(() => assemble(null, null, {}));
  const [loading, setLoading] = useState(enabled);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const [gh, google, ints] = await fetchAll();
    if (alive.current) setState(assemble(gh, google, ints));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    fetchAll()
      .then(([gh, google, ints]) => {
        if (!cancelled) setState(assemble(gh, google, ints));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const connect = useCallback(
    async (key: string) => {
      setError("");
      setConnecting(key);
      try {
        const ok = await runPopupFlow(key, async () => {
          const [gh, google, ints] = await fetchAll();
          if (alive.current) setState(assemble(gh, google, ints));
          const c = assemble(gh, google, ints).find((x) => x.key === key);
          return c?.connected ?? false;
        });
        await refresh();
        return ok;
      } catch (e) {
        if (alive.current) setError(String((e as Error).message ?? e));
        return false;
      } finally {
        if (alive.current) setConnecting(null);
      }
    },
    [refresh],
  );

  const disconnect = useCallback(
    async (key: string) => {
      setError("");
      try {
        await disconnectFor(key);
      } catch (e) {
        if (alive.current) setError(String((e as Error).message ?? e));
      }
      await refresh();
    },
    [refresh],
  );

  const byKey: Record<string, ConnectionState> = {};
  for (const c of state) byKey[c.key] = c;
  return { connections: state, byKey, loading, connecting, error, refresh, connect, disconnect };
}
