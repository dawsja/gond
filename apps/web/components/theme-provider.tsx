"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { desktopShell, mobileShell } from "@/lib/shell";
import {
  DARK_QUERY,
  THEME_STORAGE_KEY,
  applyTheme,
  followsDevice,
  isTheme,
  readStoredTheme,
  resolveTheme,
  type ResolvedTheme,
  type Theme,
} from "@/lib/theme/theme";

function syncShell(resolved: ResolvedTheme, system: boolean) {
  const background = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
  const desktop = desktopShell();
  if (typeof desktop?.setTheme === "function") {
    void desktop.setTheme(background, resolved === "dark", system);
    return;
  }
  const mobile = mobileShell();
  if (typeof mobile?.setTheme !== "function") return;
  // Android's bridge matches a call by its argument count, so only the iPhone hears whether this follows the system.
  if (mobile.platform() === "ios") mobile.setTheme(background, resolved === "dark", system);
  else mobile.setTheme(background, resolved === "dark");
}

function apply(theme: Theme) {
  const resolved = resolveTheme(theme);
  applyTheme(resolved);
  syncShell(resolved, followsDevice(theme));
}

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() =>
    typeof window === "undefined" ? "system" : readStoredTheme(),
  );

  useLayoutEffect(() => {
    apply(theme);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const onMedia = () => {
      if (followsDevice(theme)) apply(theme);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = isTheme(event.newValue) ? event.newValue : "system";
      setThemeState(next);
    };
    media.addEventListener("change", onMedia);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", onMedia);
      window.removeEventListener("storage", onStorage);
    };
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    apply(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* private mode or storage disabled: the choice lasts for this page */
    }
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
