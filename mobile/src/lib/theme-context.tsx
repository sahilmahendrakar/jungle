// ThemeProvider: resolves light/dark from an AsyncStorage preference (light | dark | system,
// key `jungle.theme`) combined with the OS appearance, mirroring the web app's theme.tsx.
// Exposes the active color map, the (always-dark) sidebar map, and a useThemedStyles() helper
// so screens can build StyleSheet objects that follow the active theme.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { StyleSheet, useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  dark,
  light,
  sidebarDark,
  sidebarLight,
  type ColorTokens,
  type SidebarTokens,
  type ThemeName,
} from "../theme";

export type ThemePref = "light" | "dark" | "system";

const STORAGE_KEY = "jungle.theme";

interface ThemeContextValue {
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
  resolved: ThemeName;
  colors: ColorTokens;
  sidebar: SidebarTokens;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme(); // "light" | "dark" | null
  const [pref, setPrefState] = useState<ThemePref>("system");

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => {
        if (v === "light" || v === "dark" || v === "system") setPrefState(v);
      })
      .catch(() => {});
  }, []);

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    AsyncStorage.setItem(STORAGE_KEY, p).catch(() => {});
  }, []);

  const resolved: ThemeName = pref === "system" ? (system === "light" ? "light" : "dark") : pref;

  const value = useMemo<ThemeContextValue>(
    () => ({
      pref,
      setPref,
      resolved,
      colors: resolved === "light" ? light : dark,
      sidebar: resolved === "light" ? sidebarLight : sidebarDark,
    }),
    [pref, setPref, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

// Build a StyleSheet from the active color map, memoized until the theme changes.
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (c: ColorTokens, sidebar: SidebarTokens) => T,
): T {
  const { colors, sidebar } = useTheme();
  return useMemo(() => StyleSheet.create(factory(colors, sidebar)), [colors, sidebar, factory]);
}
