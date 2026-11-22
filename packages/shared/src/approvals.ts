import type { z } from "zod";
import type { approvalDecisionSchema, emailEditSchema } from "./schemas.ts";

export const APPROVAL_STATUSES = ["pending", "allowed", "denied", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export type Approval = {
  id: string;
  botId: string;
  threadId: string;

  tool: string;

  summary: string;

  input: Record<string, unknown>;
  status: ApprovalStatus;

  rule: string | null;
  createdAt: string;
  resolvedAt: string | null;
  outcome: ApprovalOutcome | null;
  /** The person changed the letter on the card before it went; `input` is what went. */
  edited: boolean;
  /** What the person said when they turned it down ("make it less formal"). */
  note: string | null;
  /** The draft this one redrafts after the person asked for changes, to mark what changed. */
  revises: { tool: string; input: Record<string, unknown> } | null;
};

/**
 * Past yes or no: an email sent from its draft or saved, sent back with a note, or set aside because the person wrote instead.
 * `paused` is an expired card whose work waits on it: the person can still answer it (`isPaused`), and the bot starts again.
 */
export type ApprovalOutcome = "sent" | "saved" | "changes" | "aside" | "paused";

export function isPaused(approval: Pick<Approval, "status" | "outcome"> | null | undefined): boolean {
  return approval?.status === "expired" && approval.outcome === "paused";
}

export const MAX_APPROVAL_NOTE = 2000;

export type EmailEdit = z.infer<typeof emailEditSchema>;

export type ApprovalAnswer = z.infer<typeof approvalDecisionSchema>;
