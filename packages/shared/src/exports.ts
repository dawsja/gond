/** An export of a person's conversations, made on the server and kept for a while to download. */
export const EXPORT_STATUSES = ["preparing", "ready", "failed", "expired"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** How long a finished export is kept, and how many of a person's are listed before the oldest go. */
export const EXPORT_KEEP_DAYS = 7;
export const EXPORTS_LISTED = 5;

/** How far back an export reaches. */
export const EXPORT_RANGES = [
  { id: "all", label: "All time", days: null },
  { id: "year", label: "The last year", days: 365 },
  { id: "month", label: "The last 30 days", days: 30 },
  { id: "week", label: "The last 7 days", days: 7 },
] as const;
export type ExportRange = (typeof EXPORT_RANGES)[number]["id"];

export function isExportRange(value: unknown): value is ExportRange {
  return EXPORT_RANGES.some((range) => range.id === value);
}

export type ChatExport = {
  id: string;
  /** What it holds, in words: "All chats, all time", "Trip to Lisbon, the last 30 days". */
  label: string;
  status: ExportStatus;
  /** Conversations gathered so far, of `total`. */
  done: number;
  total: number;
  /** The zip's size in bytes once it is ready. */
  size: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
};
