import { randomBytes } from "node:crypto";
import { APPROVAL_LEVELS, BOT_TEMPLATE_FORMAT, botInputSchema, type Bot, type BotTemplateSummary } from "@gond/shared";
import { packBot, type BotBundle } from "./bot-bundle.ts";
import { ensureDatabase } from "./db/init.ts";
import { createBot, getBot, getBotAvatar, listBots, setBotAvatar } from "./data/bots.ts";
import { userTimezone } from "./data/prefs.ts";
import { createRoutine, listRoutines } from "./data/routines.ts";
import { createSkill, getSkill, getSkillBySlug, skillFiles } from "./data/skills.ts";
import { postMessage } from "./data/threads.ts";
import { now } from "./ids.ts";
import { packSkill, parseSkillMd, unpackSkill } from "./skill-bundle.ts";
import { syncSkills } from "./skills.ts";
import { greet } from "./templates.ts";
import { syncSoul } from "./responder.ts";

/** A bot as a `.bot` bundle: its job, look, approval level and routines, with the skills those use and its picture. */
export function bundleOf(bot: Bot): BotBundle {
  const skills = new Map<string, Uint8Array>();
  // A reminder is about the person's own day, not the bot's job.
  const routines = listRoutines(bot.id).filter((routine) => !routine.once).map((routine) => {
    const skill = routine.skillId ? getSkill(routine.skillId, bot.userId) : null;
    if (skill && !skills.has(skill.slug)) skills.set(skill.slug, packSkill(skill, skillFiles(skill.id)));
    return { name: routine.name, cron: routine.cron, prompt: routine.prompt, watch: routine.watch, skill: skill?.slug ?? null };
  });
  return {
    bot: { format: BOT_TEMPLATE_FORMAT, name: bot.name, title: bot.title, description: bot.description, color: bot.color, expression: bot.expression, shape: bot.shape, approval: bot.approval, routines },
    picture: getBotAvatar(bot.id)?.data ?? null,
    skills,
  };
}

export function botFile(bot: Bot): Uint8Array {
  return packBot(bundleOf(bot));
}

export function summaryOf(bundle: BotBundle): BotTemplateSummary {
  const { name, title, description, color, expression, shape, routines } = bundle.bot;
  return { name, title, description, color, expression, shape, picture: Boolean(bundle.picture), skills: [...bundle.skills.keys()], routines: routines.map((r) => r.name) };
}

/**
 * Makes the person a bot from a template. A template is never more trusting than Auto, whatever it
 * says, so a file from someone else can't hand its bot Always allow. A skill the person already has
 * by that name is used as theirs; the rest are added to their library. Routines come in switched off.
 */
export async function addFromBundle(bundle: BotBundle, userId: string): Promise<Bot> {
  const taken = new Set(listBots({ includeHidden: true, userId }).map((b) => b.name.toLowerCase()));
  let name = bundle.bot.name;
  for (let i = 2; taken.has(name.toLowerCase()); i += 1) name = `${bundle.bot.name.slice(0, 36)} ${i}`;
  const approval = APPROVAL_LEVELS.indexOf(bundle.bot.approval) < APPROVAL_LEVELS.indexOf("auto") ? bundle.bot.approval : "auto";
  const bot = createBot(botInputSchema.parse({ name, title: bundle.bot.title, description: bundle.bot.description, color: bundle.bot.color, expression: bundle.bot.expression, shape: bundle.bot.shape, approval }), userId);
  if (bundle.picture) {
    try {
      setBotAvatar(bot.id, bundle.picture);
    } catch {
      /* the mascot it is, then */
    }
  }
  const skillIds = new Map<string, string>();
  let added = 0;
  for (const [slug, bytes] of bundle.skills) {
    const mine = getSkillBySlug(userId, slug);
    if (mine) {
      skillIds.set(slug, mine.id);
      continue;
    }
    const unpacked = unpackSkill(bytes);
    if ("error" in unpacked) continue;
    const parsed = parseSkillMd(unpacked.skillMd);
    try {
      const skill = createSkill(userId, { name: (parsed.name ?? slug).slice(0, 80), description: parsed.description.slice(0, 1024), instructions: parsed.instructions }, "imported", { files: unpacked.files, meta: parsed.meta });
      skillIds.set(slug, skill.id);
      added += 1;
    } catch {
      /* a skill that doesn't fit the library stays out; its routine runs without it */
    }
  }
  if (added) void syncSkills(userId);
  const routines: string[] = [];
  for (const routine of bundle.bot.routines) {
    try {
      createRoutine(bot.id, { name: routine.name, cron: routine.cron, prompt: routine.prompt, watch: routine.watch, timezone: userTimezone(userId), enabled: false, skillId: routine.skill ? (skillIds.get(routine.skill) ?? null) : null });
      routines.push(routine.name);
    } catch {
      /* a schedule this server can't read stays out */
    }
  }
  postMessage({ threadId: bot.threadId, author: "system", kind: "event", body: `${bot.name} joined from a template.${routines.length ? ` ${routines.length === 1 ? `Its routine "${routines[0]}" is` : `Its ${routines.length} routines are`} under Routines, off until you turn ${routines.length === 1 ? "it" : "them"} on.` : ""}`, answered: true });
  await syncSoul(bot);
  greet(bot);
  return getBot(bot.id) ?? bot;
}

/** The link token for a bot's template, made the first time it is shared. */
export function shareToken(botId: string): string {
  const db = ensureDatabase();
  const row = db.query("SELECT token FROM gond_bot_shares WHERE bot_id = ?").get(botId) as { token: string } | null;
  if (row) return row.token;
  const token = randomBytes(18).toString("base64url");
  db.query("INSERT INTO gond_bot_shares (token, bot_id, created_at) VALUES (?, ?, ?)").run(token, botId, now());
  return token;
}

/** The bot a link shares, as it is now; null for a link that was never made or whose bot is gone. */
export function sharedBot(token: string): Bot | null {
  if (!/^[\w-]{10,64}$/.test(token)) return null;
  const row = ensureDatabase().query("SELECT bot_id FROM gond_bot_shares WHERE token = ?").get(token) as { bot_id: string } | null;
  return row ? getBot(row.bot_id) : null;
}
