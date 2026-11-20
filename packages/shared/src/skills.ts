import type { z } from "zod";
import type { skillInputSchema } from "./schemas.ts";

export const SKILL_LIMITS = {
  name: 60,
  slug: 40,
  description: 1024,
  instructions: 60_000,

  files: 200,
  path: 200,
  fileBytes: 5 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
} as const;
export type SkillInput = z.infer<typeof skillInputSchema>;

export type SkillFile = {
  path: string;
  size: number;

  executable: boolean;

  text: boolean;
};

export type Skill = SkillInput & {
  id: string;

  slug: string;

  source: "written" | "bot" | "packaged" | "imported";

  files: SkillFile[];
  createdAt: string;
  updatedAt: string;
};

export function skillFilePath(given: string): string | null {
  const parts = given.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === ".." || part.startsWith(".") || /[\u0000-\u001f]/.test(part))) return null;
  const clean = parts.join("/");
  if (clean.length > SKILL_LIMITS.path || clean === "SKILL.md") return null;
  return clean;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_LIMITS.slug) || "skill";
}

export function skillMentions(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)\/([a-z0-9][a-z0-9-]{0,39})\b/g)) out.add(match[1]!);
  return [...out];
}

export const PACKAGED_SKILLS: { id: string; name: string; description: string; instructions: string }[] = [
  {
    id: "morning-briefing",
    name: "Morning briefing",
    description: "What changed overnight and what needs the person today, in one short note.",
    instructions: [
      "# Morning briefing",
      "",
      "Goal: one short note the person reads with their first coffee.",
      "",
      "Steps:",
      "1. Gather what changed since yesterday: the inbox and calendar if you have them, the team's open handoffs, anything a routine left for you.",
      "2. Sort by what needs the person today, what is waiting on someone else, and what is just news.",
      "3. Write at most eight lines. Lead with decisions and deadlines. Link to the source of each item.",
      "",
      "Rules:",
      "- Never send anything on the person's behalf; this is a read-only job.",
      "- If nothing changed, say so in one line.",
      "- Note anything you could not reach (an app that failed, an expired session).",
    ].join("\n"),
  },
  {
    id: "inbox-triage",
    name: "Inbox triage",
    description: "Sort new mail into needs-reply, waiting, FYI and noise, with draft replies for the first group.",
    instructions: [
      "# Inbox triage",
      "",
      "Goal: the person opens their inbox knowing what matters and finds drafts ready where a reply is due.",
      "",
      "Steps:",
      "1. Read unread mail from the last 24 hours (or since the last run).",
      "2. Label each thread: needs a reply, waiting on someone else, FYI, or noise. Newsletters and notifications are noise unless the person asked otherwise.",
      "3. For needs-a-reply, write a draft in the person's voice and save it as a draft; never send.",
      "4. Report: a table of needs-a-reply with the draft's first line, then counts for the rest.",
      "",
      "Rules:",
      "- Sending, archiving or deleting mail waits for approval.",
      "- Keep drafts short; a question deserves an answer, not an essay.",
    ].join("\n"),
  },
  {
    id: "bug-repro-pack",
    name: "Bug repro pack",
    description: "Turn a bug report into a reproduction: steps, environment, evidence, and a suggested cause.",
    instructions: [
      "# Bug repro pack",
      "",
      "Goal: an engineer can start fixing without asking a question.",
      "",
      "Steps:",
      "1. Read the report and pull out the expected and actual behaviour.",
      "2. Reproduce it on the computer: clone the repo if there is one, run the app, follow the steps. Save screenshots and console output in your home under repro/<ticket>/.",
      "3. Narrow it: the smallest input that still fails, the first version or commit where it fails if you can bisect quickly.",
      "4. Write the pack: title, steps, environment, evidence (paths to files), suspected cause with file and line, and what you tried.",
      "",
      "Rules:",
      "- Filing the ticket or commenting on it waits for approval.",
      "- Say clearly when you could not reproduce it, and what you tried.",
    ].join("\n"),
  },
  {
    id: "weekly-expense-summary",
    name: "Weekly expense summary",
    description: "Match receipts to charges, flag the unmatched, and nudge owners.",
    instructions: [
      "# Weekly expense summary",
      "",
      "Goal: by Monday morning, every charge of the week has a receipt or an owner who was asked for one.",
      "",
      "Steps:",
      "1. Pull the week's charges from the connected source (a sheet, an export, or mail from the card provider).",
      "2. Match each to a receipt by amount, merchant and date. Keep a list of the unmatched.",
      "3. For each unmatched charge, draft a one-line nudge to its owner. Sending waits for approval.",
      "4. Report: totals by category, the unmatched list, and who was nudged.",
      "",
      "Rules:",
      "- Never guess an owner; leave it unmatched and say so.",
      "- Round to whole units in the summary; keep exact amounts in the sheet.",
    ].join("\n"),
  },
  {
    id: "meeting-prep",
    name: "Meeting prep",
    description: "A one-page brief before a meeting: who, why, what happened last time, and what to ask.",
    instructions: [
      "# Meeting prep",
      "",
      "Goal: a page the person reads in two minutes on the way in.",
      "",
      "Steps:",
      "1. From the calendar entry, find the people, the company and the stated purpose.",
      "2. Search mail, notes and the CRM (whatever you have) for the last three interactions.",
      "3. Write: attendees with one line each, the purpose, what happened last time, open items, and three questions worth asking.",
      "",
      "Rules:",
      "- Read-only. Never message attendees.",
      "- Mark anything you inferred rather than read.",
    ].join("\n"),
  },
];
