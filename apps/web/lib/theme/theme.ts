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

/** How big the phone apps draw everything, each device its own; the page zooms as Safari's page zoom does. */
export const SIZES = ["default", "large"] as const;
export type Size = (typeof SIZES)[number];

export const SIZE_LABELS: Record<Size, string> = { default: "Default", large: "Large" };

const SIZE_SCALES: Record<Size, number> = { default: 1, large: 1.15 };

const SIZE_STORAGE_KEY = "gond-size";

/** The init script refits the viewport on this event, after the person picks another size. */
const SIZE_EVENT = "gond:size";

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

export function applySize(size: Size) {
  try {
    window.localStorage.setItem(SIZE_STORAGE_KEY, size);
  } catch {
    /* private mode: it holds until the page reloads */
  }
  document.documentElement.setAttribute("data-size", size);
  window.dispatchEvent(new Event(SIZE_EVENT));
}

/** How many device points a CSS pixel takes now: 1 unless a phone app is zoomed. */
export function pageScale(): number {
  return Number.parseFloat(document.documentElement.style.getPropertyValue("--page-scale")) || 1;
}

/*
 * A size is page zoom: the viewport is laid out at the screen's width over the scale and drawn at
 * the scale, so words, bubbles and touch targets grow together and the layout reflows. Only in the
 * phone apps, and on the iPhone only in an app that scales its own header and composer to match
 * ("scale" in features()). screen.width is the portrait width on an iPhone in either orientation,
 * so the orientation picks the side. --page-scale turns what the apps report in points (insets,
 * the composer) into CSS pixels, and setScale tells the iPhone app. Next adds its own viewport tag
 * again after hydration, and the last one wins, so every one in the head is kept to the size.
 */
const SIZE_SCRIPT = `var m=window.gondMobile,f=m&&m.features?m.features():[];if(m&&(m.platform()!=="ios"||f.indexOf("scale")>=0)){var z=localStorage.getItem(${JSON.stringify(
  SIZE_STORAGE_KEY,
)}),S=${JSON.stringify(SIZE_SCALES)},V='meta[name="viewport"]',h=document.head,v=h.querySelector(V),b=v&&v.content,p=0;r.setAttribute("data-size",S[z]?z:"default");var fit=function(){var s=S[r.getAttribute("data-size")]||1,o=screen.orientation?screen.orientation.type.indexOf("landscape")===0:Math.abs(window.orientation||0)===90,w=o?Math.max(screen.width,screen.height):Math.min(screen.width,screen.height),k=Math.round(w/s),q=s===1?1:Math.round(w/k*1e4)/1e4,c=q===1?b:"width="+k+", initial-scale="+q+", minimum-scale="+q+", maximum-scale="+q+", user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content";if(q!==p){p=q;r.style.setProperty("--page-scale",String(q));if(typeof m.setScale==="function")m.setScale(q)}if(c)h.querySelectorAll(V).forEach(function(e){if(e.content!==c)e.content=c})};fit();new MutationObserver(fit).observe(h,{childList:true,subtree:true,attributes:true,attributeFilter:["content"]});addEventListener(${JSON.stringify(
  SIZE_EVENT,
)},fit);addEventListener("resize",fit);if(screen.orientation)screen.orientation.addEventListener("change",fit)}`;

export const THEME_INIT_SCRIPT = `(function(){try{var r=document.documentElement,t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});var d=t==="dark"||(t!=="light"&&matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);r.classList.toggle("dark",d);var a=localStorage.getItem(${JSON.stringify(ACCENT_STORAGE_KEY)});if(a&&/^[a-z]+$/.test(a))r.setAttribute("data-accent",a);if(window.gondMobile)r.setAttribute("data-shell","phone");${SIZE_SCRIPT}}catch(e){}})()`;
