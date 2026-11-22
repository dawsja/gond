export const EXPORT_STATUSES = ["preparing", "ready", "failed", "expired"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const EXPORT_KEEP_DAYS = 7;
export const EXPORTS_LISTED = 5;

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
  label: string;
  status: ExportStatus;
  done: number;
  total: number;
  size: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
};
