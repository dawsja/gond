/**
 * Characters a card can't show as themselves: controls, ones that draw nothing (zero-width spaces and
 * joiners, fillers) and ones that reorder the text around them (bidirectional overrides). A command
 * holding them can read one way on its card and run another.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\u115f\u1160\u2028\u2029\u3164\uffa0]/u;
const SHOWN = new Set(["\n", "\t"]);

export type TextPart = { text: string; hidden: boolean };

/** The text in runs, each hidden character a part of its own. */
export function hiddenParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let run = "";
  for (const char of text) {
    if (HIDDEN.test(char) && !SHOWN.has(char)) {
      if (run) parts.push({ text: run, hidden: false });
      run = "";
      parts.push({ text: char, hidden: true });
    } else run += char;
  }
  if (run) parts.push({ text: run, hidden: false });
  return parts;
}

/** A character as its code, the way a card names one it can't show: U+202E. */
export function codePoint(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}
