import { macShell, mobileShell } from "@/lib/shell";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "gond-theme";

/** The old Gond theme, gone: a device that saved it opens dark and keeps dark from then on. */
const RETIRED_DARK = "gond";

// The person's color lives on the server; this copy only paints the first frame before /api/me answers.
const ACCENT_STORAGE_KEY = "gond-accent";

export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function followsDevice(theme: Theme): boolean {
  return theme === "system";
}

export function themeOf(raw: unknown): Theme {
  if (raw === RETIRED_DARK) return "dark";
  return isTheme(raw) ? raw : "system";
}

export function readStoredTheme(): Theme {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return "system";
  }
  const theme = themeOf(raw);
  if (raw === RETIRED_DARK) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* private mode: read as Dark again next time */
    }
  }
  return theme;
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export const THEME_BACKGROUNDS = { light: "#f6f7f9", dark: "#000000" } as const;

export function applyTheme(resolved: ResolvedTheme, theme: Theme = resolved) {
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.setAttribute("data-theme", theme);
  const background = THEME_BACKGROUNDS[resolved];
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

/** The iPhone and Mac apps draw their own chrome, so they take a size only when they draw it to match ("scale" in features()). */
export function sizeOffered(): boolean {
  const app = mobileShell() ?? macShell();
  const own = app?.platform() === "ios" || app?.platform() === "macos";
  return !own || (typeof app?.features === "function" && app.features().includes("scale"));
}

export function applySize(size: Size) {
  try {
    window.localStorage.setItem(SIZE_STORAGE_KEY, size);
  } catch {
    /* private mode: it holds until the page reloads */
  }
  const scale = SIZE_SCALES[size];
  document.documentElement.style.fontSize = scale === 1 ? "" : `${Math.round(scale * 100)}%`;
  const app = mobileShell() ?? macShell();
  if (typeof app?.setScale === "function") app.setScale(scale);
  window.dispatchEvent(new Event("gond:size"));
}

/*
 * Every size is built as rem (postcss-rem.mjs), so a bigger root font grows the whole design, before
 * the first paint and with no zoom. The iPhone and Mac apps are told the scale on every load, Default
 * too: they keep the last one they heard while they run, and their chrome must match the page's.
 */
const SIZE_SCRIPT = `var s=localStorage.getItem(${JSON.stringify(SIZE_STORAGE_KEY)}),m=window.gondMobile||window.gondMac,p=m&&m.platform(),o=!m||(p!=="ios"&&p!=="macos")||(typeof m.features==="function"&&m.features().indexOf("scale")>=0),k=o&&s===${JSON.stringify("large")}?${SIZE_SCALES.large}:1;if(k!==1)r.style.fontSize="${Math.round(SIZE_SCALES.large * 100)}%";if(o&&m&&typeof m.setScale==="function")m.setScale(k)`;

export const THEME_INIT_SCRIPT = `(function(){try{var r=document.documentElement,t="system";try{t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t===${JSON.stringify(RETIRED_DARK)}){t="dark";localStorage.setItem(${JSON.stringify(THEME_STORAGE_KEY)},t)}}catch(e){}if(${JSON.stringify(THEMES)}.indexOf(t)<0)t="system";var d=t==="dark"||(t==="system"&&matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);r.classList.toggle("dark",d);r.setAttribute("data-theme",t);var b=${JSON.stringify(THEME_BACKGROUNDS)}[d?"dark":"light"];document.querySelectorAll('meta[name="theme-color"]').forEach(function(m){m.setAttribute("content",b)});var a=localStorage.getItem(${JSON.stringify(ACCENT_STORAGE_KEY)});if(a&&/^[a-z]+$/.test(a))r.setAttribute("data-accent",a);if(window.gondMobile)r.setAttribute("data-shell","phone");else if(window.gondMac)r.setAttribute("data-shell","mac");else if(window.gondDesktop&&typeof window.gondDesktop.setFrameless==="function"){r.setAttribute("data-shell","desktop");window.gondDesktop.setFrameless(true).catch(function(){})}${SIZE_SCRIPT}}catch(e){}})()`;
