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

/** How much bigger the phone apps draw everything than a browser would: their root font size. */
const PHONE_SCALE = 1.15;

/*
 * Every size is built as rem (postcss-rem.mjs), so the phone apps' bigger root font grows the whole
 * design, before the first paint and with no zoom. On the iPhone only in an app that draws its own
 * header and composer to match ("scale" in features()), which setScale tells.
 */
const SIZE_SCRIPT = `var m=window.gondMobile;if(m&&(m.platform()!=="ios"||(typeof m.features==="function"&&m.features().indexOf("scale")>=0))){r.style.fontSize="${Math.round(PHONE_SCALE * 100)}%";if(typeof m.setScale==="function")m.setScale(${PHONE_SCALE})}`;

export const THEME_INIT_SCRIPT = `(function(){try{var r=document.documentElement,t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});var d=t==="dark"||(t!=="light"&&matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);r.classList.toggle("dark",d);var a=localStorage.getItem(${JSON.stringify(ACCENT_STORAGE_KEY)});if(a&&/^[a-z]+$/.test(a))r.setAttribute("data-accent",a);if(window.gondMobile)r.setAttribute("data-shell","phone");${SIZE_SCRIPT}}catch(e){}})()`;
