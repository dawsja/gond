export const TEACH_MAX_MINUTES = 10;

/**
 * Where showing a bot how stands: offered on a card, being shown (or paused), waiting for the
 * person to hide what they typed outside the browser (review), the bot looking at it, its draft
 * on the card (ready), then saved as a skill, discarded or failed.
 */
export const TEACH_STATUSES = ["offered", "recording", "paused", "review", "looking", "ready", "saved", "discarded", "failed"] as const;
export type TeachStatus = (typeof TEACH_STATUSES)[number];

export type TeachStep = {
  n: number;
  /** Milliseconds from the start of the recording. */
  at: number;
  kind: string;
  layer: "browser" | "desktop";
  label: string;
  url?: string;
  app?: string;
  /** The screenshot taken just after it, by number, if one was. */
  frame: number | null;
  /** Typed outside the browser, where a password can't be told from a command. */
  outside?: boolean;
  text?: string;
  sensitive?: string;
  skipped?: boolean;
  hidden?: boolean;
};

export type TeachNote = { after: number; text: string; at: number };

export type TeachDraft = {
  name: string;
  description: string;
  steps: { text: string; shows: number | null }[];
  /** What changes each time it runs, like the month. */
  changes: string[];
  /** What it needs from the person, like a saved sign-in. */
  needs: string[];
  instructions: string;
};

export type Teaching = {
  id: string;
  botId: string;
  threadId: string;
  status: TeachStatus;
  steps: TeachStep[];
  notes: TeachNote[];
  activeMs: number;
  maxMs: number;
  pausedFor: "person" | "away" | null;
  startedAt: string | null;
  endedAt: string | null;
  endedWhy: string | null;
  frames: number;
  full: boolean;
  draft: TeachDraft | null;
  previous: TeachDraft | null;
  error: string | null;
  skillSlug: string | null;
  createdAt: string;
};
