export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "gond-theme";

// The person's color lives on the server; this copy only paints the first frame before /api/me answers.
const ACCENT_STORAGE_KEY = "gond-accent";

export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** System is light or dark as the device is; Light and Dark are the person's own pick. */
export function followsDevice(theme: Theme): boolean {
  return theme === "system";
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
  if (!followsDevice(theme)) return theme as ResolvedTheme;
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

/** How much bigger the phone apps draw everything than a browser would. */
const PHONE_SCALE = 1.15;

/** The first iPhone app that draws its own header and composer at the page's scale ("scale" in features()). */
const IOS_SCALES_FROM = [0, 2, 91] as const;

/**
 * The scale a page is laid out at, from the app named in the user agent ("Gond/0.2.91 (iOS)"):
 * the phone apps' pages are zoomed so words, bubbles and touch targets are bigger; a browser's
 * and the desktop app's aren't.
 */
export function appScale(userAgent: string | null): number {
  const app = /\bGond\/(\d+)\.(\d+)\.(\d+) \((Android|iOS)\)/.exec(userAgent ?? "");
  if (!app) return 1;
  if (app[4] === "Android") return PHONE_SCALE;
  const rank = ([major, minor, patch]: readonly number[]) => major! * 1e6 + minor! * 1e3 + patch!;
  return rank(app.slice(1, 4).map(Number)) >= rank(IOS_SCALES_FROM) ? PHONE_SCALE : 1;
}

/** How many device points a CSS pixel takes now: 1 unless a phone app is zoomed. */
export function pageScale(): number {
  return Number.parseFloat(document.documentElement.style.getPropertyValue("--page-scale")) || 1;
}

/*
 * The zoom the server laid the page out at (`appScale` in the viewport tag), as --page-scale, which
 * turns what the apps report in points (insets, the composer) into CSS pixels; setScale tells the
 * iPhone app, which draws its own header and composer at it.
 */
const ZOOM_SCRIPT = `var v=document.querySelector('meta[name="viewport"]'),x=v&&/initial-scale=([\\d.]+)/.exec(v.content),q=x?parseFloat(x[1]):1,m=window.gondMobile;if(q>1){r.style.setProperty("--page-scale",String(q));if(m&&typeof m.setScale==="function")m.setScale(q)}`;

export const THEME_INIT_SCRIPT = `(function(){try{var r=document.documentElement,t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});var d=t==="dark"||(t!=="light"&&matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);r.classList.toggle("dark",d);var a=localStorage.getItem(${JSON.stringify(ACCENT_STORAGE_KEY)});if(a&&/^[a-z]+$/.test(a))r.setAttribute("data-accent",a);if(window.gondMobile)r.setAttribute("data-shell","phone");${ZOOM_SCRIPT}}catch(e){}})()`;
