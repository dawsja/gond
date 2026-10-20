export function botInk(color: string): string {
  return `color-mix(in oklab, ${color}, var(--carbon) var(--bot-ink-mix))`;
}
