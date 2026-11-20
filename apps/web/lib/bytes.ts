const UNITS = ["KB", "MB", "GB", "TB"] as const;

/** A size the way a person reads it: one decimal under ten of a unit, whole numbers above. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  let value = bytes / 1024;
  let unit = 0;
  // Up a unit before rounding could show 1024 of this one.
  while (value >= 1023.5 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${shown} ${UNITS[unit]}`;
}
