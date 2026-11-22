export function checkedAgo(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "a day ago" : `${days} days ago`;
}

export function percentOf(part: number, total: number): number {
  return total > 0 ? Math.round(Math.min(100, Math.max(0, (part / total) * 100))) : 0;
}

export function diskLow(free: number, total: number): boolean {
  return total > 0 && free / total < 0.1;
}
