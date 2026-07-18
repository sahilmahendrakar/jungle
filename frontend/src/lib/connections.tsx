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

// Official full-color product marks, inlined from the vendors' published SVGs (Google's 2020
// marks; Granola's from granola.ai — its favicon renders the curl in near-black, so it follows
// text-foreground like GitHub's mark). `fill` omitted = currentColor. These take precedence over
// the monochrome glyphs above: the Google family's brand guidelines call for the real marks,
// and they read far better at tile size. "google" maps to the Gmail envelope — that connection
// IS the Gmail grant (renamed in Settings accordingly).
type RichGlyph = { viewBox: string; transform?: string; paths: { d: string; fill?: string }[] };

const GMAIL_RICH: RichGlyph = {
  viewBox: "52 42 88 66",
  paths: [
    { d: "M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6", fill: "#4285f4" },
    { d: "M120 108h14c3.32 0 6-2.69 6-6V59l-20 15", fill: "#34a853" },
    { d: "M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2", fill: "#fbbc04" },
    { d: "M72 74V48l24 18 24-18v26L96 92", fill: "#ea4335" },
    { d: "M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2", fill: "#c5221f" },
  ],
};

const RICH_BRAND_GLYPHS: Record<string, RichGlyph> = {
  gmail: GMAIL_RICH,
  google: GMAIL_RICH,
  "google-drive": {
    viewBox: "0 0 87.3 78",
    paths: [
      { d: "m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z", fill: "#0066da" },
      { d: "m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z", fill: "#00ac47" },
      { d: "m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z", fill: "#ea4335" },
      { d: "m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z", fill: "#00832d" },
      { d: "m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z", fill: "#2684fc" },
      { d: "m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z", fill: "#ffba00" },
    ],
  },
  "google-calendar": {
    viewBox: "0 0 200 200",
    transform: "translate(3.75 3.75)",
    paths: [
      { d: "M148.882,43.618l-47.368-5.263l-57.895,5.263L38.355,96.25l5.263,52.632l52.632,6.579l52.632-6.579l5.263-53.947L148.882,43.618z", fill: "#FFFFFF" },
      { d: "M65.211,125.276c-3.934-2.658-6.658-6.539-8.145-11.671l9.132-3.763c0.829,3.158,2.276,5.605,4.342,7.342c2.053,1.737 4.553,2.592,7.474,2.592c2.987,0,5.553-0.908,7.697-2.724s3.224-4.132,3.224-6.934c0-2.868-1.132-5.211-3.395-7.026s-5.105-2.724-8.5-2.724h-5.276v-9.039H76.5c2.921,0,5.382-0.789,7.382-2.368c2-1.579,3-3.737,3-6.487c0-2.447-0.895-4.395-2.684-5.855s-4.053-2.197-6.803-2.197c-2.684,0-4.816,0.711-6.395,2.145s-2.724,3.197-3.447,5.276l-9.039-3.763c1.197-3.395,3.395-6.395,6.618-8.987c3.224-2.592,7.342-3.895,12.342-3.895c3.697,0,7.026,0.711,9.974,2.145c2.947,1.434,5.263,3.421,6.934,5.947c1.671,2.539,2.5,5.382,2.5,8.539c0,3.224-0.776,5.947-2.329,8.184c-1.553,2.237-3.461,3.947-5.724,5.145v0.539c2.987,1.25,5.421,3.158,7.342,5.724c1.908,2.566,2.868,5.632,2.868,9.211s-0.908,6.776-2.724,9.579c-1.816,2.803-4.329,5.013-7.513,6.618c-3.197,1.605-6.789,2.421-10.776,2.421C73.408,129.263,69.145,127.934,65.211,125.276z", fill: "#1A73E8" },
      { d: "M121.25,79.961l-9.974,7.25l-5.013-7.605l17.987-12.974h6.895v61.197h-9.895L121.25,79.961z", fill: "#1A73E8" },
      { d: "M148.882,196.25l47.368-47.368l-23.684-10.526l-23.684,10.526l-10.526,23.684L148.882,196.25z", fill: "#EA4335" },
      { d: "M33.092,172.566l10.526,23.684h105.263v-47.368H43.618L33.092,172.566z", fill: "#34A853" },
      { d: "M12.039-3.75C3.316-3.75-3.75,3.316-3.75,12.039v136.842l23.684,10.526l23.684-10.526V43.618h105.263l10.526-23.684L148.882-3.75H12.039z", fill: "#4285F4" },
      { d: "M-3.75,148.882v31.579c0,8.724,7.066,15.789,15.789,15.789h31.579v-47.368H-3.75z", fill: "#188038" },
      { d: "M148.882,43.618v105.263h47.368V43.618l-23.684-10.526L148.882,43.618z", fill: "#FBBC04" },
      { d: "M196.25,43.618V12.039c0-8.724-7.066-15.789-15.789-15.789h-31.579v47.368H196.25z", fill: "#1967D2" },
    ],
  },
  granola: {
    viewBox: "0 0 40 40",
    paths: [
      { d: "M22.1137 9.29854C23.327 9.12219 26.7606 9.15242 27.276 10.5191C26.9821 12.2533 22.9676 10.9968 21.4283 11.0817C17.9473 11.2733 16.1922 12.9161 13.4731 14.7208C8.70209 17.8874 5.39937 25.6132 9.23225 30.5822C10.8198 32.6294 13.1625 33.9546 15.7339 34.2609C23.8312 35.2656 35.0209 26.2349 31.9327 17.4897C31.4243 16.048 29.9575 14.8478 30.1441 13.2929C30.4757 12.8151 30.3781 12.9542 30.9632 12.6928C31.8018 13.2334 32.3074 13.8379 32.7963 14.729C33.4775 15.9735 34.3648 18.4101 33.9859 19.8103C33.8912 20.1613 33.7909 20.587 33.7031 20.9422C33.8327 21.1287 33.9636 21.3138 34.0974 21.4974C34.0444 22.1562 33.5444 23.4008 33.2964 24.0897C33.0443 24.532 33.132 25.2334 32.969 25.6393C29.3487 34.6223 17.5893 40.0807 9.31611 33.5973C7.26455 31.9894 5.80933 29.1935 5.58966 26.7942C5.18514 22.8005 6.40997 18.8129 8.98654 15.7349C12.8179 11.1597 16.2075 9.82243 22.1137 9.29854Z" },
      { d: "M33.7855 3.4707L34.0222 3.69942C33.8579 4.48617 34.1852 4.94292 34.6212 5.56544C30.2947 10.1803 27.1466 16.642 23.8815 22.0853C22.7657 23.9463 21.9564 26.0864 20.7682 27.9387L20.6261 28.0046C19.9477 28.3155 19.6775 28.5009 18.9908 28.2475C17.9168 27.2932 17.6257 20.7492 17.2928 18.6539C15.9151 19.8369 14.2561 21.8372 14.5737 23.7754L14.4316 24.5605C14.1084 24.9268 14.2742 24.8127 13.7254 24.945C11.1202 24.4281 13.8619 19.1953 15.0083 17.9989C19.4045 13.4147 19.8307 21.8754 19.9965 24.7573C20.8908 23.4005 21.7057 21.5217 22.547 20.1825C25.6686 15.2209 29.6846 7.36153 33.7855 3.4707Z" },
    ],
  },
};

// The raw brand glyph (an SVG path on a 24×24 viewBox, or the official multi-color mark when
// one exists in RICH_BRAND_GLYPHS).
export function BrandGlyph({ brand, className }: { brand: string; className?: string }) {
  const rich = RICH_BRAND_GLYPHS[brand];
  if (rich) {
    const paths = rich.paths.map((p, i) => <path key={i} d={p.d} fill={p.fill} />);
    return (
      <svg viewBox={rich.viewBox} className={cn("shrink-0 text-foreground", className)} aria-hidden>
        {rich.transform ? <g transform={rich.transform}>{paths}</g> : paths}
      </svg>
    );
  }
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
