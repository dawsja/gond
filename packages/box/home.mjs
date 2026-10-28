import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The image installs it here, where the Chrome policy's new tab and Home button point; a dev checkout uses its own copy.
const INSTALLED = "/usr/share/gond/home/index.html";
const LOCAL = path.join(path.dirname(fileURLToPath(import.meta.url)), "home", "index.html");

const HOME_FILE = fs.existsSync(INSTALLED) ? INSTALLED : LOCAL;

const COLOR = /^#?([0-9a-f]{6})$/i;

/** A bot's name and colour from a request, kept only when they are plain: the page shows them as text and a fill. */
export function lookOf(body = {}) {
  const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  const color = typeof body.color === "string" ? (COLOR.exec(body.color.trim())?.[1]?.toLowerCase() ?? "") : "";
  return { name, color };
}

/** The homepage for a bot's browser; the page remembers the bot, so a new tab without these still shows it. */
export function homeUrl(look = {}, file = HOME_FILE) {
  const url = pathToFileURL(file);
  if (look.name) url.searchParams.set("name", look.name);
  if (look.color) url.searchParams.set("color", look.color);
  return url.href;
}

export function isHomePage(url) {
  return typeof url === "string" && url.startsWith("file://") && /\/home\/index\.html(\?[^#]*)?(#.*)?$/.test(url);
}
