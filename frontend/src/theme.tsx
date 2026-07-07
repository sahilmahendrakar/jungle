// App theme (light / dark / system). The resolved theme is applied as a `.dark` class on
// <html> (matching index.css's @custom-variant) and mirrored into <meta name="theme-color">
// so mobile browser chrome matches. Persisted in localStorage; "system" tracks the OS live.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "jungle-theme";

// Browser-chrome colors per resolved theme: dark = the .dark --background family; light keeps
// the deep forest brand color the app has always used for its (dark) sidebar.
const META_COLOR = { light: "#04271a", dark: "#0c1a15" } as const;

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function loadPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* storage unavailable — default */
  }
  return "system";
}

function applyResolved(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? META_COLOR.dark : META_COLOR.light);
}

const ThemeContext = createContext<{
  preference: ThemePreference;
  resolved: "light" | "dark";
  setPreference: (p: ThemePreference) => void;
}>({ preference: "system", resolved: "light", setPreference: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(loadPreference);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  // Track the OS preference live so "system" flips without a reload.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved: "light" | "dark" =
    preference === "system" ? (systemDark ? "dark" : "light") : preference;

  useEffect(() => {
    applyResolved(resolved === "dark");
  }, [resolved]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* storage unavailable — session-only */
    }
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  return useContext(ThemeContext);
}
