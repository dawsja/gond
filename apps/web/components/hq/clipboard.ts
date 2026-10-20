export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* no permission, no focus, or no gesture: try the old way */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const done = document.execCommand("copy");
    area.remove();
    return done;
  } catch {
    return false;
  }
}

export function isPasteChord(event: KeyboardEvent) {
  if (event.altKey) return false;
  const primary = event.ctrlKey || event.metaKey;
  if (event.code === "KeyV" && primary) return true;
  return event.code === "Insert" && event.shiftKey && !primary;
}

export function isTerminalCopyChord(event: KeyboardEvent) {
  if (event.altKey) return false;
  if (event.code === "KeyC" && event.shiftKey && (event.ctrlKey || event.metaKey)) return true;
  return event.code === "Insert" && event.ctrlKey && !event.shiftKey;
}
