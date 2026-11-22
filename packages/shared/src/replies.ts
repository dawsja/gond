/** A bot answers a routine run with this when there is nothing worth telling the person; the run then leaves no trace in the chat. */
export const QUIET_REPLY = "NOTHING_NEW";

export function routineName(body: string): string | null {
  return /^\[(?:Routine|Watch): ([^\]\n]+)\]/.exec(body)?.[1]?.trim() || null;
}

export function isWatchRun(body: string): boolean {
  return body.startsWith("[Watch: ");
}

export function isQuietReply(text: string): boolean {
  return /^[\s`*_]*nothing_new[\s`*_.]*$/i.test(text);
}

/**
 * A reply with the marker taken out wherever it stands alone, on a line of its own or ending the text: a
 * model that answers and then adds it (for a line steered in mid-turn that had nothing for it) still posts
 * its answer, never the marker. Empty when the reply was only the marker.
 */
export function withoutQuietReply(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isQuietReply(line))
    .join("\n")
    .replace(/[ \t`*_]*\bnothing_new[\s`*_.]*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function plainMarkdown(text: string): string {
  return text
    .replace(/:badge\[([^\]]*)\](?:\{[^}\n]*\})?/g, "$1")
    .replace(/^[ \t]*::meter\{([^}\n]*)\}[ \t]*$/gm, (_, attrs: string) => {
      const label = /\blabel="([^"]*)"/.exec(attrs)?.[1]?.trim() ?? "";
      const value = Number(/\bvalue=("?)([^\s"}]*)\1/.exec(attrs)?.[2]);
      const max = Number(/\bmax=("?)([^\s"}]*)\1/.exec(attrs)?.[2] ?? "100");
      const fallback = Number.isFinite(value) && max > 0 ? `${Math.round(Math.min(100, Math.max(0, (value / max) * 100)))}%` : "";
      const words = /\btext="([^"]*)"/.exec(attrs)?.[1]?.trim() || fallback;
      return label && words ? `${label}: ${words}` : label || words;
    })
    .replace(/^[ \t]*::choices\[([^\]\n]*)\](?:\{[^}\n]*\})?[ \t]*$/gm, (_, options: string) => options.split("|").map((option) => option.trim()).filter(Boolean).join(" or ") + "?")
    .replace(/^[ \t]*:::[^\n]*$/gm, "")
    .replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, "")
    .replace(/!\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"\n]*")?\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^)\s]*(?:\s+"[^"\n]*")?\)/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, "$1")
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>\n]*)?\/?>/g, " ")
    .replace(/^[ \t]*[|:\- \t]*-[|:\- \t]*$/gm, "")
    .replace(/^[ \t]*\|(.*?)\|?[ \t]*$/gm, (_, cells: string) => cells.split("|").map((cell) => cell.trim()).filter(Boolean).join(" · "))
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/\*\*/g, "")
    .replace(/~~/g, "")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)?\*(?![\w*])/g, "$1$2")
    .replace(/(^|\W)__(?=\S)([^\n]*?\S)?__(?!\w)/g, "$1$2")
    .replace(/(^|\W)_(?=[^\s_])([^_\n]*?[^\s_])?_(?!\w)/g, "$1$2")
    .replace(/`/g, "")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
