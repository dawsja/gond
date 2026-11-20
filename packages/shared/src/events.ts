import type { ImageAspect } from "./ai.ts";
import type { ChatExport } from "./exports.ts";
import type { Reaction } from "./messages.ts";
import type { DesktopState } from "./screen.ts";
import type { Teaching } from "./teach.ts";
import type { WorkStep } from "./work.ts";

export type LiveEvent =

  | { topic: "bots"; userId?: string }
  /** A message landed on a thread, or (cleared) every message was removed. */
  | { topic: "thread"; threadId: string; cleared?: true }
  /** A message's reactions changed: all of them as they now stand. */
  | { topic: "reactions"; threadId: string; messageId: string; reactions: Reaction[] }
  /** A bot's live activity while it works: the line, or null when the turn ended. */
  | { topic: "activity"; threadId: string; botId: string; line: string | null }
  /**
   * The reply a bot is writing for the person, as far as it has got (already redacted), or null when
   * it stopped: posted, or it was narration before a tool call.
   */
  | { topic: "writing"; threadId: string; botId: string; text: string | null }
  /** A step of a bot's work began or finished: the step as it now stands (see WorkStep). */
  | { topic: "work"; threadId: string; botId: string; step: WorkStep }
  /** Approvals changed: the owning profile's, or with no `userId` everyone's. */
  | { topic: "approvals"; userId?: string }
  /** Routines or connections changed: one profile's, or with no `userId` the whole server's. */
  | { topic: "settings"; userId?: string }
  /** The computer's update moved a step. */
  | { topic: "box" }
  /** Your own profile (name, picture) changed. */
  | { topic: "me"; userId: string }
  /** Your AI settings or API keys changed. */
  | { topic: "ai"; userId: string }
  /** Your skills library changed. */
  | { topic: "skills"; userId: string }
  /** One of your chat exports moved on: as it now stands, or gone. */
  | { topic: "exports"; userId: string; export: ChatExport | null; id: string }
  /**
   * A bot finished a job for you or needs you: what the API just sent as a
   * push notification, for a client without Web Push (the Android app)
   * to show on its own. Quiet when that conversation is in front of you.
   */
  | { topic: "notify"; userId: string; title: string; body: string; url: string; tag: string; threadId: string; botId?: string | null }
  /** One of your other profiles has something new, or your profiles changed: `userId` is the person. */
  | { topic: "profiles"; userId: string }
  /** Your desktop on the computer: who is driving it, and whether it is up. */
  | { topic: "desktop"; userId: string; desktop: DesktopState }
  /** Something you're showing a bot, or showed it, as it now stands. */
  | { topic: "teaching"; userId: string; teaching: Teaching }
  /** Spaces changed: this Gond's connection, a space joined or left. Without a userId, everyone's. */
  | { topic: "spaces"; userId?: string }
  /** What your bots used, or how much of your plan is left, changed. */
  | { topic: "usage"; userId: string }
  /**
   * A picture a bot is making: its shape at once, a rough preview's URL when the API sends one,
   * then done, with the attachment it was posted as, or failed.
   */
  | { topic: "picture"; threadId: string; botId: string; id: string; aspect: ImageAspect; state: "making" | "preview" | "done" | "failed"; preview: string | null; file: string | null };
