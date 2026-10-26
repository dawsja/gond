const UNITS = ["KB", "MB", "GB", "TB"] as const;

/** A size the way a person reads it: one decimal under ten of a unit, whole numbers above. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${shown} ${UNITS[unit]}`;
}

/** How long ago a check ran, in words. */
export function checkedAgo(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "a day ago" : `${days} days ago`;
}

/** Whole percent of `part` in `total`, 0 to 100. */
export function percentOf(part: number, total: number): number {
  return total > 0 ? Math.round(Math.min(100, Math.max(0, (part / total) * 100))) : 0;
}

/** Disk is worth a warning once less than a tenth of it is free. */
export function diskLow(free: number, total: number): boolean {
  return total > 0 && free / total < 0.1;
}
