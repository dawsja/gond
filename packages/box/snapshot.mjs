// What a bot can act on, read from Playwright's AI snapshot of the page
// (`page.ariaSnapshot({ mode: "ai", boxes: true })`): one line per control or
// heading on screen, with the ref a step names it by and where its middle is.
// The whole tree runs to 100k characters on a busy page; this is a few
// thousand, so it can come back with every batch.

const ROLES = new Set([
  "heading", "link", "button", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "slider",
  "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem",
]);
// Sites that draw their own box hide the real input (0 by 0, no ref); a person clicks the row around it.
const CHECKABLE = new Set(["checkbox", "radio", "switch"]);
const STATES = /\[(checked|selected|disabled|expanded|pressed|level)(?:=([^\]]+))?\]/g;
const NAME_CHARS = 80;
const VALUE_CHARS = 60;
const URL_CHARS = 60;
export const MAX_LINES = 250;
const MAX_CHARS = 14_000;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const parse = (line) => {
  const head = /^(\s*)- (\w+)(?: "((?:[^"\\]|\\.)*)")?/.exec(line);
  if (!head) return null;
  const box = /\[box=(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+)\]/.exec(line);
  return {
    indent: head[1].length,
    role: head[2],
    name: head[3] ?? "",
    ref: /\[ref=([a-z0-9]+)\]/i.exec(line)?.[1] ?? null,
    box: box ? box.slice(1).map(Number) : null,
  };
};

const sized = (box) => box && box[2] >= 2 && box[3] >= 2;

function rowOf(lines, i, parsed) {
  const own = parsed[i];
  for (let j = i - 1; j >= 0; j--) {
    const up = parsed[j];
    if (!up || up.indent >= own.indent) continue;
    if (!up.ref || !sized(up.box)) {
      if (up.indent === 0) return null;
      continue;
    }
    if (ROLES.has(up.role)) return null;
    for (let k = j + 1; k < lines.length; k++) {
      const inner = parsed[k];
      if (!inner) continue;
      if (inner.indent <= up.indent) break;
      if (k !== i && ROLES.has(inner.role) && inner.role !== "heading") return null;
    }
    return up;
  }
  return null;
}

export function snapshotControls(snapshot) {
  const lines = String(snapshot ?? "").split("\n");
  const parsed = lines.map(parse);
  const controls = [];
  for (const [i, line] of lines.entries()) {
    const at = parsed[i];
    if (!at || !ROLES.has(at.role)) continue;
    let { ref, box } = at;
    if (CHECKABLE.has(at.role) && (!ref || !sized(box))) {
      const row = rowOf(lines, i, parsed);
      if (row) ({ ref, box } = row);
    }
    if (!ref || !sized(box)) continue;
    const [x, y, width, height] = box;
    // The name stays as Playwright escaped it, so a quote inside it can't end the line's quotes.
    controls.push({
      ref,
      role: at.role,
      name: at.name,
      states: [...line.matchAll(STATES)].map((m) => (m[2] ? `${m[1]}=${m[2]}` : m[1])),
      value: at.role === "heading" ? null : (/\]: (.+)$/.exec(line)?.[1] ?? null),
      url: at.role === "link" ? (/^\s*- \/url: (.+)$/.exec(lines[i + 1] ?? "")?.[1] ?? null) : null,
      box: { x, y, width, height },
    });
  }
  return controls;
}

export function compactSnapshot(snapshot, view, unseen = new Set()) {
  const out = [];
  const entries = [];
  let above = 0;
  let below = 0;
  let chars = 0;
  let cut = 0;
  let inside = 0;
  for (const { ref, role, name, states, value, url, box } of snapshotControls(snapshot)) {
    const { x, y, width, height } = box;
    if (y + height <= 0) {
      above++;
      continue;
    }
    if (y >= view.height) {
      below++;
      continue;
    }
    if (x + width <= 0 || x >= view.width) continue;
    if (unseen.has(ref)) {
      inside++;
      continue;
    }
    const key = [
      `${ref} ${role}`,
      name ? ` "${clip(name, NAME_CHARS)}"` : "",
      states.length ? ` (${states.join(", ")})` : "",
      value ? ` = ${JSON.stringify(clip(value, VALUE_CHARS))}` : "",
      url ? ` -> ${clip(url, URL_CHARS)}` : "",
    ].join("");
    const entry = `${key} @${Math.round(x + width / 2)},${Math.round(y + height / 2)}`;
    if (out.length >= MAX_LINES || chars + entry.length > MAX_CHARS) {
      cut++;
      continue;
    }
    out.push(entry);
    entries.push({ ref, key, line: entry, box });
    chars += entry.length + 1;
  }
  const notes = [];
  if (above) notes.push(`${above} more above`);
  if (below + cut) notes.push(`${below + cut} more below`);
  const scroll = notes.length ? `${notes.join(", ")}; scroll to reach them.` : "";
  const panel = inside ? `${inside} more scrolled out of sight inside a panel; scroll the panel, or name them by label.` : "";
  return { text: out.join("\n"), count: out.length, above, below: below + cut, inside, note: [scroll, panel].filter(Boolean).join(" "), entries };
}

// A change list this close to the whole one says little less, and the whole one reads more easily.
const CHANGES_SHARE = 0.6;

/**
 * A page's list told as what changed since an earlier list of the same page that the bot has seen:
 * the lines that are new or read differently, the refs no longer on screen, and how many are as they
 * were. One that only moved (a scroll) is as it was, since its ref still finds it. Null when that would
 * say about as much as the whole list.
 */
export function listChanges(before, after) {
  const was = new Map(before.map((entry) => [entry.ref, entry.key]));
  const here = new Set(after.map((entry) => entry.ref));
  const changed = after.filter((entry) => was.get(entry.ref) !== entry.key);
  const gone = before.filter((entry) => !here.has(entry.ref)).map((entry) => entry.ref);
  const text = changed.map((entry) => entry.line).join("\n");
  const whole = after.map((entry) => entry.line).join("\n").length;
  if (text.length + gone.join(", ").length >= whole * CHANGES_SHARE) return null;
  return { text, gone, same: after.length - changed.length };
}
