import { mobileShell } from "@/lib/shell";

export const THEMES = ["system", "light", "dark", "gond"] as const;
export type Theme = (typeof THEMES)[number];
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "gond-theme";

// The person's color lives on the server; this copy only paints the first frame before /api/me answers.
const ACCENT_STORAGE_KEY = "gond-accent";

export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** System follows the device; Gond is an explicit dark palette. */
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
  if (theme === "gond") return "dark";
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export const THEME_BACKGROUNDS = { light: "#f5f3ee", dark: "#121212", gond: "#000000" } as const;

export function applyTheme(resolved: ResolvedTheme, theme: Theme = resolved) {
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.setAttribute("data-theme", theme);
  const background = THEME_BACKGROUNDS[theme === "gond" ? "gond" : resolved];
  // Both media variants must reflect an explicit choice, even when the device uses another scheme.
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.setAttribute("content", background));
}

export function applyAccent(accent: string) {
  document.documentElement.setAttribute("data-accent", accent);
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  } catch {
    /* private mode: the server's color still applies once it loads */
  }
}

/** Settings → Appearance → Size, each device's own: how much bigger than the design everything is drawn, as the root font size. */
export const SIZES = ["default", "large"] as const;
export type Size = (typeof SIZES)[number];
export const SIZE_LABELS: Record<Size, string> = { default: "Default", large: "Large" };
const SIZE_SCALES: Record<Size, number> = { default: 1, large: 1.15 };
const SIZE_STORAGE_KEY = "gond-size";

export function isSize(value: unknown): value is Size {
  return typeof value === "string" && (SIZES as readonly string[]).includes(value);
}

export function readStoredSize(): Size {
  try {
    const raw = window.localStorage.getItem(SIZE_STORAGE_KEY);
    return isSize(raw) ? raw : "default";
  } catch {
    return "default";
  }
}

/** An iPhone app draws its own header and composer, so it takes a size only when it draws them to match ("scale" in features()). */
export function sizeOffered(): boolean {
  const mobile = mobileShell();
  return !mobile || mobile.platform() !== "ios" || (typeof mobile.features === "function" && mobile.features().includes("scale"));
}

export function applySize(size: Size) {
  try {
    window.localStorage.setItem(SIZE_STORAGE_KEY, size);
  } catch {
    /* private mode: it holds until the page reloads */
  }
  const scale = SIZE_SCALES[size];
  document.documentElement.style.fontSize = scale === 1 ? "" : `${Math.round(scale * 100)}%`;
  const mobile = mobileShell();
  if (typeof mobile?.setScale === "function") mobile.setScale(scale);
  window.dispatchEvent(new Event("gond:size"));
}

/*
 * Every size is built as rem (postcss-rem.mjs), so a bigger root font grows the whole design, before
 * the first paint and with no zoom. An iPhone app is told the scale on every load, Default too: it
 * keeps the last one it heard while it runs, and its header and composer must match the page's.
 */
const SIZE_SCRIPT = `var s=localStorage.getItem(${JSON.stringify(SIZE_STORAGE_KEY)}),m=window.gondMobile,o=!m||m.platform()!=="ios"||(typeof m.features==="function"&&m.features().indexOf("scale")>=0),k=o&&s===${JSON.stringify("large")}?${SIZE_SCALES.large}:1;if(k!==1)r.style.fontSize="${Math.round(SIZE_SCALES.large * 100)}%";if(o&&m&&typeof m.setScale==="function")m.setScale(k)`;

export const THEME_INIT_SCRIPT = `(function(){try{var r=document.documentElement,t="system";try{t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});}catch(e){}if(${JSON.stringify(THEMES)}.indexOf(t)<0)t="system";var d=t==="gond"||t==="dark"||(t==="system"&&matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);r.classList.toggle("dark",d);r.setAttribute("data-theme",t);var b=${JSON.stringify(THEME_BACKGROUNDS)}[t==="gond"?"gond":d?"dark":"light"];document.querySelectorAll('meta[name="theme-color"]').forEach(function(m){m.setAttribute("content",b)});var a=localStorage.getItem(${JSON.stringify(ACCENT_STORAGE_KEY)});if(a&&/^[a-z]+$/.test(a))r.setAttribute("data-accent",a);if(window.gondMobile)r.setAttribute("data-shell","phone");${SIZE_SCRIPT}}catch(e){}})()`;
