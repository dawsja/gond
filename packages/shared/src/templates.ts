import type { z } from "zod";
import type { BotExpression } from "./bots.ts";
import type { botTemplateSchema } from "./schemas.ts";

/** What `bot.json` in a `.bot` file says: a bot's job and look and its routines, never its memory, secrets or chats. */
export const BOT_TEMPLATE_FORMAT = "gond.bot/1";

export type BotTemplateFile = z.infer<typeof botTemplateSchema>;

/** A template as the person sees it before adding it: who the bot is and what comes with it. */
export type BotTemplateSummary = Pick<BotTemplateFile, "name" | "title" | "description" | "color" | "expression" | "shape"> & { skills: string[]; routines: string[] };

export type BotTemplate = {
  id: string;
  name: string;
  title: string;
  tagline: string;
  color: string;
  expression: BotExpression;
  description: string;
  routine?: { name: string; cron: string; prompt: string };
};

/** One entry of a folder in a bot's home, as the Files section lists it. */
export type BotFileEntry = { name: string; dir: boolean; size: number; modified: string | null };

export const BOT_TEMPLATES: BotTemplate[] = [
  {
    id: "assistant",
    name: "Assistant",
    title: "Assistant",
    tagline: "Your always-on assistant. Reads what changed and what needs you, and briefs the others.",
    color: "#7650D8",
    expression: "wink",
    description:
      "Own the outcome of what the person asks. Scan the connected channels, inbox, calendar and notes for what is new and what maps to their priorities; for each item give the source, why it matters, the proposed next step, and whether they owe a decision. Coordinate the other bots when a job fits one of them, and return one consolidated answer. Never send messages or change meetings without approval.",
    routine: { name: "Morning briefing", cron: "0 8 * * 1-5", prompt: "Review activity since yesterday across my connected channels, inbox and calendar. Return only items that map to my priorities, each with the source, why it matters, the proposed next step, and whether I owe a decision." },
  },
  {
    id: "sales-outbound",
    name: "Sales Outbound",
    title: "Sales Outbound",
    tagline: "Researches accounts overnight, drafts outreach in your voice, and leaves a review list.",
    color: "#E04E0A",
    expression: "happy",
    description:
      "Own account research, contact prioritisation and review-ready outreach. Score accounts against the ideal customer profile and recent intent, find up to three relevant contacts per account, and draft email outreach in the person's voice. Skip anyone already in an active sequence. Always return a review list; never send or enrol anyone yourself.",
  },
  {
    id: "inbox-manager",
    name: "Inbox Manager",
    title: "Inbox Manager",
    tagline: "Triages email into clear categories, surfaces what's urgent, drafts replies.",
    color: "#2F6FD6",
    expression: "surprised",
    description:
      "Keep the inbox usable. Triage new mail into categories, surface urgent and blocked threads, and draft replies and clean-up. Every send stays behind approval. Report what changed in a few lines, newest first.",
    routine: { name: "Inbox triage", cron: "0 9,13,17 * * 1-5", prompt: "Triage everything new in the inbox since the last run. List urgent and blocked threads first, then drafts waiting for my approval." },
  },
  {
    id: "talent-scout",
    name: "Talent Scout",
    title: "Talent Scout",
    tagline: "Sources candidates, drafts outreach, preps scheduling.",
    color: "#11998A",
    expression: "wink",
    description:
      "Own sourcing, candidate research, outreach drafts and scheduling preparation. For a role, find candidates who meet the must-have criteria, explain the evidence for each match, and draft personalised outreach in the person's voice. Never contact anyone without approval. Respect candidate privacy and source terms.",
  },
  {
    id: "expense-manager",
    name: "Expense Manager",
    title: "Expense Manager",
    tagline: "Builds the weekly expense summary, matches receipts, nudges owners.",
    color: "#D98A08",
    expression: "happy",
    description:
      "Own weekly expense reconciliation and missing-information follow-up. Build the week's summary, match receipts from the inbox, flag missing categories or policy exceptions with a policy citation, and draft one follow-up per owner. Return the summary and drafts; never send messages or change reimbursements.",
    routine: { name: "Weekly expense summary", cron: "0 9 * * 1", prompt: "Build last week's expense summary: totals that reconcile, receipts matched, exceptions with policy citations, and one follow-up draft per owner." },
  },
  {
    id: "bug-reproduction",
    name: "Bug Reproduction",
    title: "Bug Reproduction",
    tagline: "Turns reports into repro packs: steps, screenshots, console notes.",
    color: "#D03A3A",
    expression: "surprised",
    description:
      "Turn bug reports into reliable reproduction packs. Read the report, reproduce it in a staging environment or a fresh clone in your home folder, and return exact steps, expected and actual behaviour, screenshots, environment details, relevant console or network notes, and a minimal test case when possible. Never use production customer data.",
  },
  {
    id: "product-performance",
    name: "Product Performance",
    title: "Product Performance",
    tagline: "Investigates performance questions with evidence and links.",
    color: "#0B8EC8",
    expression: "happy",
    description:
      "Investigate product-performance questions using the connected observability and source tools. Preserve links and screenshots, separate evidence from hypotheses, and return a short write-up with the highest-impact issue first. Never change alerts or production settings.",
  },
  {
    id: "account-health",
    name: "Account Health",
    title: "Account Health",
    tagline: "Turns portfolio noise into a ranked watch list before the QBR.",
    color: "#CF3D85",
    expression: "wink",
    description:
      "Review the accounts in the portfolio. Combine usage, support escalations, renewal timing and stakeholder activity into a ranked watch list; for each account include the evidence, why it matters, and a suggested next step. Never contact customers or edit the CRM without approval.",
  },
];

export const BOT_NAMES = [
  "Scout", "Pixel", "Atlas", "Nova", "Juno", "Koda", "Miso", "Mochi", "Biscuit", "Pepper", "Clover", "Ember",
  "Willow", "Comet", "Orbit", "Echo", "Indigo", "Sage", "Zephyr", "Poppy", "Maple", "Cosmo", "Luna", "Otto",
  "Ivy", "Finch", "Wren", "Basil", "Hazel", "Nimbus", "Onyx", "Pearl", "Quill", "Rocket", "Sunny", "Tango",
  "Vega", "Waffle", "Ziggy", "Noodle", "Pickle", "Churro", "Panko", "Dumpling", "Pesto", "Olive", "Cocoa", "Taffy",
] as const;

export function pickBotName(taken: Iterable<string>, random = Math.random): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const free = BOT_NAMES.filter((n) => !used.has(n.toLowerCase()));
  if (free.length > 0) return free[Math.floor(random() * free.length)]!;
  const base = BOT_NAMES[Math.floor(random() * BOT_NAMES.length)]!;
  for (let i = 2; ; i += 1) {
    if (!used.has(`${base.toLowerCase()} ${i}`)) return `${base} ${i}`;
  }
}
