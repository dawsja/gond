export const RETENTION_DAYS = [0, 30, 90, 365] as const;
export type RetentionDays = (typeof RETENTION_DAYS)[number];

export function isRetentionDays(value: unknown): value is RetentionDays {
  return typeof value === "number" && (RETENTION_DAYS as readonly number[]).includes(value);
}

export type BackupReason = "manual" | "pre-update";

export type BackupInfo = {
  name: string;
  reason: BackupReason;
  size: number;
  createdAt: string;
};

export type DatabaseStats = {
  totalBytes: number;
  walBytes: number;
  messagesBytes: number;
  attachmentsBytes: number;
  usageBytes: number;
  exportsBytes: number;
  teachingsBytes: number;
  attachmentCount: number;
  usageCount: number;
};

export type ServerRetention = {
  usageKeepDays: RetentionDays;
  attachmentsKeepDays: RetentionDays;
};

export type ServerStorage = {
  db: DatabaseStats;
  /** Free space on the disk the database and its backups share. */
  freeBytes: number;
  backups: BackupInfo[];
  retention: ServerRetention;
};

export type CompactResult = {
  /** Space inside the database freed for it to use again; the file on disk keeps its size. */
  freedBytes: number;
  prunedUsage: number;
  prunedAttachments: number;
  prunedExports: number;
  db: DatabaseStats;
};
