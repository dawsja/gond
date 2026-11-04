/** Keep the wider layout until the draft empties, so moving the buttons cannot undo its own wrap. */
export function composerLayout(value: string, needsRows: boolean, previousStacked: boolean): boolean {
  return value.length > 0 && (needsRows || previousStacked);
}
