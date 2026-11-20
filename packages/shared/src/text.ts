/** "Patch", "Patch and Net", "Patch, Net and Sentry"; nothing for an empty list. */
export function joinNames(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
