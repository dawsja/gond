export const THEMES = ["system", "dark", "light"] as const;
export type Theme = (typeof THEMES)[number];
export type ResolvedTheme = Exclude<Theme, "system">;

export const THEME_STORAGE_KEY = "gond-theme";

// The person's color lives on the server; this copy only paints the first frame before /api/me answers.
export const ACCENT_STORAGE_KEY = "gond-accent";

export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function readStoredTheme(): Theme {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== "system") return theme;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

export function applyAccent(accent: string) {
  document.documentElement.setAttribute("data-accent", accent);
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  } catch {
    /* private mode: the server's color still applies once it loads */
  }
}

export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});var d=t==="dark"||(t!=="light"&&matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);document.documentElement.classList.toggle("dark",d);var a=localStorage.getItem(${JSON.stringify(ACCENT_STORAGE_KEY)});if(a&&/^[a-z]+$/.test(a))document.documentElement.setAttribute("data-accent",a);if(window.gondMobile)document.documentElement.setAttribute("data-shell","android")}catch(e){}})()`;
