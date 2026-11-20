import { z } from "zod";
import { MAX_APPROVAL_NOTE } from "./approvals.ts";
import { APPROVAL_LEVELS, BOT_COLORS, BOT_EXPRESSIONS, BOT_LIMITS, BOT_SHAPES } from "./bots.ts";
import { MCP_TRANSPORTS } from "./mcp.ts";
import { SKILL_LIMITS } from "./skills.ts";
import { BOT_TEMPLATE_FORMAT } from "./templates.ts";

const botFields = z.object({
  name: z.string().trim().min(1).max(BOT_LIMITS.name),

  title: z.string().trim().max(BOT_LIMITS.title),

  description: z.string().trim().max(BOT_LIMITS.description),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  expression: z.enum(BOT_EXPRESSIONS),
  shape: z.enum(BOT_SHAPES),
  approval: z.enum(APPROVAL_LEVELS),

  notify: z.boolean(),
});

export const botInputSchema = botFields.extend({
  title: botFields.shape.title.default(""),
  description: botFields.shape.description.default(""),
  color: botFields.shape.color.default(BOT_COLORS[0]),
  expression: botFields.shape.expression.default("happy"),
  shape: botFields.shape.shape.default("cog"),
  approval: botFields.shape.approval.default("auto"),
  notify: botFields.shape.notify.default(true),
});

/**
 * A change to some of a bot's fields; the rest stay as they are. Not
 * `botInputSchema.partial()`: with zod 4 that fills every missing field
 * with its default, so pinning a bot would have made it forget its job.
 */
export const botPatchSchema = botFields.partial();

const editedList = z.array(z.string().trim().min(3).max(320)).max(50);

export const emailEditSchema = z.object({
  to: editedList,
  cc: editedList,
  bcc: editedList,
  subject: z.string().max(998),
  body: z.string().max(100_000),
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(["allow", "deny", "always"]),
  /** On a draft's card: send it rather than leave it saved. */
  send: z.boolean().optional(),
  /** On an email's card: the letter as the person changed it. */
  edit: emailEditSchema.optional(),
  /** With a deny: what to change, told to the bot. */
  note: z.string().trim().min(1).max(MAX_APPROVAL_NOTE).optional(),
});

const routineFields = z.object({
  name: z.string().trim().min(1).max(80),
  cron: z.string().trim().min(9).max(100),
  timezone: z.string().trim().min(1).max(64),
  prompt: z.string().trim().min(1).max(4000),
  enabled: z.boolean(),
  watch: z.boolean(),

  skillId: z.string().trim().max(40).nullable(),
});
export const routineInputSchema = routineFields.extend({
  timezone: routineFields.shape.timezone.default("UTC"),
  enabled: routineFields.shape.enabled.default(true),
  watch: routineFields.shape.watch.default(false),
  skillId: routineFields.shape.skillId.default(null),
});

export const botTemplateSchema = z.object({
  format: z.literal(BOT_TEMPLATE_FORMAT),
  name: botFields.shape.name,
  title: botFields.shape.title.default(""),
  description: botFields.shape.description.default(""),
  color: botFields.shape.color.default(BOT_COLORS[0]),
  expression: botFields.shape.expression.default("happy"),
  // A template from an older Gond may name a shape since retired; it comes in wearing the cog rather than being refused.
  shape: botFields.shape.shape.catch("cog"),
  approval: botFields.shape.approval.default("auto"),
  routines: z
    .array(z.object({ name: routineFields.shape.name, cron: routineFields.shape.cron, prompt: routineFields.shape.prompt, watch: z.boolean().default(false), skill: z.string().trim().max(80).nullable().default(null) }))
    .max(20)
    .default([]),
});

export const oidcPatchSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(40).optional(),
  issuer: z.string().trim().url().max(500).optional(),
  clientId: z.string().trim().max(500).optional(),
  clientSecret: z.string().max(2000).optional(),
  scopes: z.string().trim().max(200).optional(),
});

export const providerInputSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .refine((value) => /^https?:\/\/[^\s/]+/i.test(value), "The URL starts with http:// or https://"),

  apiKey: z.string().trim().min(8, "That key looks too short").max(8_000).optional(),
});

const skillFields = z.object({
  name: z.string().trim().min(1).max(SKILL_LIMITS.name),

  description: z.string().trim().max(SKILL_LIMITS.description),

  instructions: z.string().trim().min(1).max(SKILL_LIMITS.instructions),
});
export const skillInputSchema = skillFields.extend({ description: skillFields.shape.description.default("") });

export const skillPatchSchema = skillFields.partial();

export const mcpServerInputSchema = z.object({
  name: z.string().trim().min(1).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/i, "Letters, digits, dashes and underscores"),
  transport: z.enum(MCP_TRANSPORTS),

  url: z.string().trim().url().max(500).optional(),

  headers: z.record(z.string().max(100), z.string().max(4000)).default({}),

  command: z.string().trim().max(500).optional(),
  args: z.array(z.string().max(500)).max(50).default([]),
  env: z.record(z.string().max(100), z.string().max(4000)).default({}),
  enabled: z.boolean().default(true),

  oauthRedirect: z.enum(["app", "localhost"]).optional(),
});
