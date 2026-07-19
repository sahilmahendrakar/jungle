// Jungle design tokens — ported from the web app's "deep jungle" palette (frontend/src/index.css).
// The web uses OKLCH CSS variables; RN has no CSS vars, so these are exact OKLCH→sRGB hex
// conversions of every token, split into light / dark maps consumed via ThemeProvider
// (src/lib/theme-context.tsx). The sidebar/Home surface is always-dark forest green in BOTH
// themes (it matches the app icon, #04271a family) — hence a separate sidebar map per theme.

export interface ColorTokens {
  background: string;
  foreground: string;
  card: string;
  popover: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
}

export const light: ColorTokens = {
  background: "#f9fbf9",
  foreground: "#121b17",
  card: "#ffffff",
  popover: "#ffffff",
  primary: "#007756",
  primaryForeground: "#f9fdfb",
  secondary: "#f1f4f2",
  secondaryForeground: "#222b27",
  muted: "#f0f3f1",
  mutedForeground: "#5b6760",
  accent: "#e3f1e9",
  accentForeground: "#033727",
  destructive: "#e3121e",
  destructiveForeground: "#fbfbff",
  border: "#dfe4e1",
  input: "#dfe4e1",
  ring: "#007756",
};

export const dark: ColorTokens = {
  background: "#0d1914",
  foreground: "#e2eae5",
  card: "#15231d",
  popover: "#14211b",
  primary: "#3cc292",
  primaryForeground: "#00140c",
  secondary: "#202c26",
  secondaryForeground: "#d9e0dc",
  muted: "#1e2924",
  mutedForeground: "#8c9991",
  accent: "#22352c",
  accentForeground: "#e9f1ec",
  destructive: "#f14d4c",
  destructiveForeground: "#fcf7f7",
  border: "#27342e",
  input: "#2c3933",
  ring: "#3cc292",
};

export interface SidebarTokens {
  bg: string;
  fg: string;
  fgMuted: string;
  primary: string;
  accent: string;
  accentFg: string;
  border: string;
}

// Light theme: forest green sidebar sits ABOVE a light canvas.
export const sidebarLight: SidebarTokens = {
  bg: "#012619",
  fg: "#dee7e2",
  fgMuted: "rgba(222,231,226,0.55)",
  primary: "#2ab186",
  accent: "#123c2b",
  accentFg: "#f2fbf6",
  border: "#143829",
};

// Dark theme: sidebar sinks a step BELOW the dark canvas for depth.
export const sidebarDark: SidebarTokens = {
  bg: "#01130b",
  fg: "#d8e1db",
  fgMuted: "rgba(216,225,219,0.55)",
  primary: "#3cc292",
  accent: "#0c281c",
  accentFg: "#f2fbf6",
  border: "#0d241b",
};

// Agent status dots (frontend/src/lib/chat.ts STATUS_DOT). `pulse` drives an Animated loop.
export const status: Record<
  string,
  { color: string; pulse?: boolean; ring?: string }
> = {
  working: { color: "#34d399", pulse: true }, // emerald-400
  idle: { color: "rgba(16,185,129,0.6)" }, // emerald-500/60
  waking: { color: "#fbbf24", pulse: true }, // amber-400
  sleeping: { color: "rgba(148,163,184,0.7)" }, // slate-400/70
  offline: { color: "rgba(100,116,139,0.4)", ring: "rgba(100,116,139,0.3)" },
};

// Approvals amber card (frontend/src Approvals + ConfirmCard).
export const amber = {
  light: { border: "rgba(252,211,77,0.6)", bg: "rgba(255,251,235,0.7)", icon: "#d97706" },
  dark: { border: "rgba(245,158,11,0.3)", bg: "rgba(245,158,11,0.06)", icon: "#f59e0b" },
};

// Emerald accents used by turn chips (running state).
export const emerald = {
  base: "#10b981",
  bright: "#34d399",
  check: "#059669",
  border: "rgba(16,185,129,0.3)",
  bg: "rgba(16,185,129,0.06)",
};

// highlight.js token colors (frontend/src/index.css .hljs rules), light + dark.
export const hljsLight = {
  base: light.foreground,
  comment: light.mutedForeground,
  keyword: "#763ebd",
  title: "#195daa",
  string: "#00704e",
  number: "#a84811",
  builtin: "#265368",
};
export const hljsDark = {
  base: dark.foreground,
  comment: dark.mutedForeground,
  keyword: "#c994f0",
  title: "#80bdfb",
  string: "#6bcf9d",
  number: "#eba66d",
  builtin: "#83b7c8",
};

// Deterministic avatar palette (tailwind-500 hexes), ported from frontend/src/lib/people.ts.
export const avatarPalette = [
  "#f43f5e", // rose
  "#f97316", // orange
  "#f59e0b", // amber
  "#10b981", // emerald
  "#14b8a6", // teal
  "#0ea5e9", // sky
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#d946ef", // fuchsia
  "#ec4899", // pink
];

// --radius: 0.7rem ≈ 11.2px base; web uses sm/md/lg/xl + rounded-2xl (16) + rounded-full.
export const radius = { sm: 7, md: 9, lg: 11, xl: 15, xxl: 16, pill: 999 } as const;

export const space = (n: number) => n * 4;

export const font = {
  xs: 11,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 20,
  title: 26,
  // Set to the loaded Inter/JetBrains families in Phase 8 (after the font-bundling EAS build).
  sans: undefined as string | undefined,
  mono: "Menlo",
} as const;

// Browser-chrome / status-bar colors from web theme.tsx META_COLOR.
export const chrome = { light: "#04271a", dark: "#0c1a15" } as const;

export type ThemeName = "light" | "dark";

// ── Backward-compat shim ──────────────────────────────────────────────────────
// The pre-existing screens (app/index.tsx, app/channel/[id].tsx, src/screens/SignIn.tsx,
// app/_layout.tsx) import `{ theme }` and use theme.color.*/space/radius/font. Keep this
// dark-leaning shim alive so they compile; each screen is migrated to useTheme() during its
// phase, after which this export is removed.
export const theme = {
  color: {
    bg: dark.background,
    surface: dark.card,
    surfaceAlt: dark.secondary,
    border: dark.border,
    text: dark.foreground,
    textDim: dark.mutedForeground,
    jade: dark.primary,
    jadeDim: "#0C7A5E",
    danger: dark.destructive,
    mention: dark.primary,
  },
  space,
  radius: { sm: radius.sm, md: radius.md, lg: radius.lg, pill: radius.pill },
  font: { sm: 13, md: 15, lg: 17, xl: 22, title: 28 },
} as const;

export type Theme = typeof theme;
