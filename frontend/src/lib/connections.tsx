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
  // X (formerly Twitter): official monochrome mark — black in light mode, white in dark.
  x:
    "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
  slack:
    "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
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
// marks; Granola's curl from granola.ai, rendered on its chartreuse brand tile — lime square +
// near-black curl, which reads in both light and dark themes). `fill` omitted = currentColor.
// These take precedence over the monochrome glyphs above: the Google family's brand guidelines
// call for the real marks, and they read far better at tile size. "google" maps to the Gmail
// envelope — that connection IS the Gmail grant (renamed in Settings accordingly).
type RichGlyph = {
  viewBox: string;
  transform?: string;
  // Full-viewBox rounded tile behind the glyph (Granola's lime square), when the mark is
  // branded as a tile rather than a bare glyph.
  background?: { fill: string; rx?: number };
  // A path is either filled ({d, fill}) or stroked ({d, stroke, strokeWidth}) — Granola's
  // spiral is a thick round-capped stroke, not a filled outline.
  paths: ({ d: string; fill?: string } | { d: string; stroke: string; strokeWidth: number })[];
};

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
    background: { fill: "#b2c248", rx: 9 },
    paths: [
      { d: "M27.17 9.76L26.91 9.60L26.64 9.45L26.38 9.31L26.11 9.17L25.83 9.04L25.56 8.92L25.28 8.80L25.00 8.69L24.71 8.59L24.43 8.50L24.14 8.41L23.85 8.33L23.56 8.26L23.27 8.19L22.98 8.13L22.68 8.08L22.39 8.03L22.09 8.00L21.80 7.97L21.50 7.94L21.21 7.93L20.91 7.92L20.62 7.92L20.32 7.92L20.03 7.94L19.73 7.96L19.44 7.99L19.15 8.02L18.86 8.06L18.57 8.11L18.29 8.17L18.00 8.23L17.72 8.30L17.44 8.37L17.16 8.46L16.88 8.55L16.61 8.64L16.34 8.74L16.07 8.85L15.81 8.97L15.55 9.09L15.29 9.22L15.04 9.35L14.79 9.49L14.54 9.64L14.30 9.79L14.06 9.95L13.83 10.11L13.60 10.28L13.37 10.45L13.15 10.63L12.94 10.81L12.73 11.00L12.52 11.19L12.32 11.39L12.13 11.59L11.94 11.80L11.75 12.01L11.57 12.22L11.40 12.44L11.23 12.67L11.07 12.89L10.91 13.12L10.76 13.36L10.62 13.59L10.48 13.83L10.35 14.08L10.22 14.32L10.10 14.57L9.99 14.82L9.88 15.07L9.78 15.33L9.68 15.59L9.59 15.84L9.51 16.10L9.44 16.37L9.37 16.63L9.31 16.90L9.25 17.16L9.20 17.43L9.16 17.69L9.12 17.96L9.10 18.23L9.07 18.50L9.06 18.77L9.05 19.04L9.04 19.30L9.05 19.57L9.06 19.84L9.08 20.10L9.10 20.37L9.13 20.63L9.16 20.90L9.21 21.16L9.26 21.42L9.31 21.68L9.37 21.93L9.44 22.19L9.51 22.44L9.59 22.69L9.68 22.94L9.77 23.18L9.87 23.43L9.97 23.67L10.08 23.90L10.19 24.14L10.31 24.37L10.44 24.59L10.57 24.82L10.70 25.04L10.84 25.25L10.99 25.47L11.14 25.67L11.29 25.88L11.45 26.08L11.62 26.27L11.79 26.47L11.96 26.65L12.14 26.84L12.32 27.01L12.51 27.19L12.70 27.35L12.89 27.52L13.09 27.67L13.29 27.83L13.49 27.97L13.70 28.12L13.91 28.25L14.12 28.39L14.33 28.51L14.55 28.63L14.77 28.75L15.00 28.86L15.22 28.96L15.45 29.06L15.68 29.15L15.91 29.24L16.14 29.32L16.38 29.39L16.61 29.46L16.85 29.52L17.09 29.58L17.33 29.63L17.57 29.68L17.81 29.72L18.05 29.75L18.29 29.78L18.53 29.80L18.77 29.82L19.01 29.83L19.25 29.83L19.49 29.83L19.73 29.82L19.97 29.80L20.21 29.79L20.45 29.76L20.68 29.73L20.92 29.69L21.15 29.65L21.38 29.60L21.61 29.55L21.84 29.49L22.07 29.42L22.29 29.35L22.52 29.28L22.74 29.20L22.95 29.11L23.17 29.02L23.38 28.92L23.59 28.82L23.80 28.72L24.00 28.61L24.20 28.49L24.40 28.37L24.59 28.24L24.78 28.11L24.97 27.98L25.15 27.84L25.33 27.70L25.51 27.55L25.68 27.40L25.85 27.25L26.01 27.09L26.17 26.93L26.33 26.77L26.48 26.60L26.62 26.43L26.76 26.25L26.90 26.07L27.03 25.89L27.16 25.71L27.28 25.52L27.40 25.33L27.52 25.14L27.62 24.95L27.73 24.75L27.83 24.55L27.92 24.35L28.01 24.15L28.09 23.95L28.17 23.74L28.24 23.53L28.31 23.32L28.37 23.12L28.43 22.91L28.48 22.69L28.52 22.48L28.56 22.27L28.60 22.06L28.63 21.84L28.66 21.63L28.68 21.41L28.69 21.20L28.70 20.99L28.70 20.77L28.70 20.56L28.70 20.35L28.68 20.13L28.67 19.92L28.65 19.71L28.62 19.50L28.59 19.30L28.55 19.09L28.51 18.88L28.46 18.68L28.41 18.48L28.35 18.28L28.29 18.08L28.22 17.88L28.15 17.69L28.08 17.49L28.00 17.30L27.91 17.11L27.82 16.93L27.73 16.75L27.63 16.57L27.53 16.39L27.43 16.21L27.32 16.04L27.20 15.88L27.08 15.71L26.96 15.55L26.84 15.39L26.71 15.23L26.58 15.08L26.44 14.94L26.30 14.79L26.16 14.65L26.02 14.51L25.87 14.38L25.72 14.25L25.56 14.13L25.41 14.01L25.25 13.89L25.09 13.78L24.92 13.67L24.76 13.57L24.59 13.47L24.42 13.37L24.25 13.28L24.07 13.19L23.90 13.11L23.72 13.03L23.54 12.96L23.36 12.89L23.18 12.83L23.00 12.77L22.82 12.72L22.63 12.67L22.45 12.62L22.26 12.58L22.08 12.54L21.89 12.51L21.70 12.49L21.52 12.46L21.33 12.45L21.14 12.43L20.96 12.43L20.77 12.42L20.58 12.42L20.40 12.43L20.21 12.44L20.03 12.45L19.84 12.47L19.66 12.50L19.48 12.52L19.30 12.56L19.12 12.59L18.94 12.63L18.77 12.68L18.59 12.73L18.42 12.78L18.25 12.84L18.08 12.90L17.91 12.97L17.75 13.04L17.58 13.11L17.42 13.19L17.27 13.27L17.11 13.35L16.96 13.44L16.80 13.53L16.66 13.63L16.51 13.73L16.37 13.83L16.23 13.93L16.09 14.04L15.96 14.15L15.83 14.27L15.70 14.38L15.57 14.50L15.45 14.63L15.33 14.75L15.22 14.88L15.11 15.01L15.00 15.14L14.90 15.28L14.80 15.41L14.70 15.55L14.61 15.70L14.52 15.84L14.43 15.98L14.35 16.13L14.27 16.28L14.20 16.43L14.13 16.58L14.06 16.73L14.00 16.88L13.94 17.04L13.89 17.20L13.84 17.35L13.79 17.51L13.75 17.67L13.71 17.83L13.68 17.98L13.65 18.14L13.62 18.30L13.60 18.46L13.58 18.62L13.56 18.78L13.55 18.94L13.55 19.10L13.54 19.26L13.55 19.42L13.55 19.58L13.56 19.74L13.57 19.90L13.59 20.05L13.61 20.21L13.64 20.36L13.66 20.51L13.70 20.67L13.73 20.82L13.77 20.97L13.81 21.12L13.86 21.26L13.91 21.41L13.96 21.55L14.02 21.69L14.08 21.83L14.14 21.97L14.21 22.11L14.28 22.24L14.35 22.37L14.42 22.50L14.50 22.63L14.58 22.76L14.67 22.88L14.75 23.00L14.84 23.12L14.94 23.23L15.03 23.34L15.13 23.45L15.23 23.56L15.33 23.67L15.43 23.77L15.54 23.87L15.65 23.96L15.76 24.05L15.87 24.14L15.98 24.23L16.10 24.31L16.22 24.39L16.34 24.47L16.46 24.55L16.58 24.62L16.70 24.68L16.83 24.75L16.95 24.81L17.08 24.87L17.21 24.92L17.34 24.97L17.47 25.02L17.60 25.06L17.73 25.11L17.86 25.14L17.99 25.18L18.13 25.21L18.26 25.24L18.39 25.26", stroke: "#1e1e1e", strokeWidth: 3.4 },
      { d: "M15.8 20a4.2 4.2 0 1 0 8.4 0a4.2 4.2 0 1 0 -8.4 0z", fill: "#1e1e1e" },
    ],
  },
};

// The raw brand glyph (an SVG path on a 24×24 viewBox, or the official multi-color mark when
// one exists in RICH_BRAND_GLYPHS).
export function BrandGlyph({ brand, className }: { brand: string; className?: string }) {
  const rich = RICH_BRAND_GLYPHS[brand];
  if (rich) {
    const paths = rich.paths.map((p, i) =>
      "stroke" in p ? (
        <path
          key={i}
          d={p.d}
          fill="none"
          stroke={p.stroke}
          strokeWidth={p.strokeWidth}
          strokeLinecap="round"
        />
      ) : (
        <path key={i} d={p.d} fill={p.fill} />
      ),
    );
    const [, , vbw, vbh] = rich.viewBox.split(" ").map(Number);
    return (
      <svg viewBox={rich.viewBox} className={cn("shrink-0 text-foreground", className)} aria-hidden>
        {rich.background && (
          <rect width={vbw} height={vbh} rx={rich.background.rx ?? 0} fill={rich.background.fill} />
        )}
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
