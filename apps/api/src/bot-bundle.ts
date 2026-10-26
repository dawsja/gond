import { BOT_TEMPLATE_FORMAT, botTemplateSchema, type BotTemplateFile } from "@gond/shared";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { pictureType } from "./images.ts";

/** A `.bot` file: the bot as `bot.json`, its picture, and each skill its routines use as a `.skill`. */
export type BotBundle = { bot: BotTemplateFile; picture: Uint8Array | null; skills: Map<string, Uint8Array> };

export const MAX_BOT_BUNDLE_BYTES = 40 * 1024 * 1024;

const SKILL = /^skills\/([a-z0-9][a-z0-9-]{0,79})\.skill$/;
const AT = { os: 3, mtime: new Date("2020-01-01T00:00:00Z") };

export function packBot(bundle: BotBundle): Uint8Array {
  const entries: Zippable = {};
  entries["bot.json"] = [new TextEncoder().encode(`${JSON.stringify(bundle.bot, null, 2)}\n`), AT];
  if (bundle.picture) entries["picture"] = [bundle.picture, AT];
  for (const [slug, bytes] of bundle.skills) entries[`skills/${slug}.skill`] = [bytes, { ...AT, level: 0 }];
  return zipSync(entries, { level: 6 });
}

export function unpackBot(bytes: Uint8Array): BotBundle | { error: string } {
  let listing: { name: string; size: number }[] = [];
  try {
    unzipSync(bytes, {
      filter: (file) => {
        listing.push({ name: file.name, size: file.originalSize });
        return false;
      },
    });
  } catch {
    return { error: "That isn't a .bot file." };
  }
  listing = listing.filter((entry) => entry.name === "bot.json" || entry.name === "picture" || SKILL.test(entry.name));
  if (!listing.some((entry) => entry.name === "bot.json")) return { error: "There's no bot.json in it." };
  if (listing.reduce((sum, entry) => sum + entry.size, 0) > MAX_BOT_BUNDLE_BYTES) return { error: `A .bot file comes to at most ${MAX_BOT_BUNDLE_BYTES / 1024 / 1024} MB.` };
  const names = new Set(listing.map((entry) => entry.name));
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (file) => names.has(file.name) });
  } catch {
    return { error: "The file is damaged." };
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(files["bot.json"]));
  } catch {
    return { error: "bot.json isn't readable." };
  }
  const parsed = botTemplateSchema.safeParse(json);
  if (!parsed.success) return { error: (json as { format?: unknown })?.format === BOT_TEMPLATE_FORMAT ? `bot.json: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}` : "That isn't a .bot file from Gond." };
  // Only a picture's own bytes make it a picture, so an SVG or a page can't ride in as one.
  const picture = files["picture"] && pictureType(files["picture"]) ? files["picture"] : null;
  const skills = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(files)) {
    const slug = SKILL.exec(name)?.[1];
    if (slug) skills.set(slug, data);
  }
  return { bot: parsed.data, picture, skills };
}
