// Backend origin resolution for the mobile app.
//
// Priority:
//   1. A dev-only runtime override persisted in AsyncStorage (the in-app server switcher) —
//      lets one dev build point at preprod / prod / a LAN box without rebuilding.
//   2. EXPO_PUBLIC_API_URL, inlined at build time by Expo (set per-profile in eas.json:
//      dev build → preprod, preview/production → prod).
//   3. A hardcoded prod fallback so a bare `expo start` still works.
//
// The WS origin is derived from the API origin (http→ws, https→wss). Unlike the web app there's
// no `location` to fall back to — a native app always needs an explicit origin.
import AsyncStorage from "@react-native-async-storage/async-storage";

const PROD_API = "https://api.jungleagents.com";
const PREPROD_API = "https://preprod-api.52.87.26.31.sslip.io";

const OVERRIDE_KEY = "jungle.serverOverride";

// Known targets the in-app switcher offers. "custom" lets you type a LAN/tunnel origin.
export const SERVER_PRESETS = {
  prod: PROD_API,
  preprod: PREPROD_API,
} as const;
export type ServerPreset = keyof typeof SERVER_PRESETS;

function envBase(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL?.replace(/\/+$/, "");
  return fromEnv || PROD_API;
}

// Mutable module state: initialized from env, then possibly overridden by initConfig() reading
// the persisted dev override. Reads go through getBase()/getWsBase() so an override applied at
// startup is visible everywhere without a rebuild.
let apiBase = envBase();

function toWs(base: string): string {
  return base.replace(/^http/, "ws");
}

export function getBase(): string {
  return apiBase;
}
export function getWsBase(): string {
  return toWs(apiBase);
}

// Call once at app startup (before any API/WS use) to apply a persisted dev override.
export async function initConfig(): Promise<void> {
  try {
    const saved = await AsyncStorage.getItem(OVERRIDE_KEY);
    if (saved) apiBase = saved.replace(/\/+$/, "");
  } catch {
    /* no override; keep env base */
  }
}

// Persist and apply a new backend origin (dev server switcher). Returns the applied origin.
// A full app reload isn't required — subsequent requests read getBase() — but the live WebSocket
// should be reconnected by the caller so it re-handshakes against the new origin.
export async function setServer(origin: string): Promise<string> {
  const clean = origin.replace(/\/+$/, "");
  apiBase = clean;
  try {
    await AsyncStorage.setItem(OVERRIDE_KEY, clean);
  } catch {
    /* best-effort persistence */
  }
  return clean;
}

// Clear the override, reverting to the build-time env origin.
export async function clearServerOverride(): Promise<void> {
  apiBase = envBase();
  try {
    await AsyncStorage.removeItem(OVERRIDE_KEY);
  } catch {
    /* ignore */
  }
}
