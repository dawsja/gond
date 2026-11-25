import type { ImageAspect } from "./ai.ts";
import type { ChatExport } from "./exports.ts";
import type { Reaction } from "./messages.ts";
import type { DesktopState } from "./screen.ts";
import type { Teaching } from "./teach.ts";
import type { WorkStep } from "./work.ts";

export type LiveEvent =

  | { topic: "bots"; userId?: string }
  | { topic: "thread"; threadId: string; cleared?: true }
  | { topic: "reactions"; threadId: string; messageId: string; reactions: Reaction[] }
  | { topic: "activity"; threadId: string; botId: string; line: string | null }
  /**
   * The reply a bot is writing for the person, as far as it has got (already redacted), or null when
   * it stopped: posted, or it was narration before a tool call.
   */
  | { topic: "writing"; threadId: string; botId: string; text: string | null }
  | { topic: "work"; threadId: string; botId: string; step: WorkStep }
  /** Approvals changed: the owning profile's, or with no `userId` everyone's. */
  | { topic: "approvals"; userId?: string }
  /** Routines or connections changed: one profile's, or with no `userId` the whole server's. */
  | { topic: "settings"; userId?: string }
  /** The computer's update moved a step. */
  | { topic: "box" }
  | { topic: "me"; userId: string }
  | { topic: "ai"; userId: string }
  | { topic: "skills"; userId: string }
  | { topic: "exports"; userId: string; export: ChatExport | null; id: string }
  /**
   * A bot finished a job for you or needs you: what the API just sent as a
   * push notification, for a client without Web Push (the Android app)
   * to show on its own. Quiet when that conversation is in front of you.
   */
  | { topic: "notify"; userId: string; title: string; body: string; url: string; tag: string; threadId: string; botId?: string | null }
  /** One of your other profiles has something new, or your profiles changed: `userId` is the person. */
  | { topic: "profiles"; userId: string }
  | { topic: "desktop"; userId: string; desktop: DesktopState }
  | { topic: "teaching"; userId: string; teaching: Teaching }
  | { topic: "usage"; userId: string }
  | { topic: "picture"; threadId: string; botId: string; id: string; aspect: ImageAspect; state: "making" | "preview" | "done" | "failed"; preview: string | null; file: string | null };
