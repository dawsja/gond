import type { AppCatalogEntry } from "@gond/shared";

function squash(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function words(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

type Field = { text: string; words: string[] };

function field(raw: string): Field {
  return { text: squash(raw), words: words(raw) };
}

type Indexed = {
  app: AppCatalogEntry;
  name: Field;
  slug: Field;
  category: Field;

  about: string;
};

export type AppIndex = {
  apps: AppCatalogEntry[];
  bySlug: Map<string, AppCatalogEntry>;

  byWord: Map<string, AppCatalogEntry>;
  entries: Indexed[];
  letters: Uint32Array;
  digits: Uint16Array;
};

function maskOf(text: string): { letters: number; digits: number } {
  let letters = 0;
  let digits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 97 && code <= 122) letters |= 1 << (code - 97);
    else if (code >= 48 && code <= 57) digits |= 1 << (code - 48);
  }
  return { letters, digits };
}

export function indexApps(apps: AppCatalogEntry[]): AppIndex {
  const entries: Indexed[] = [];
  const letters = new Uint32Array(apps.length);
  const digits = new Uint16Array(apps.length);
  const bySlug = new Map<string, AppCatalogEntry>();
  const byWord = new Map<string, AppCatalogEntry>();
  apps.forEach((app, i) => {
    const entry: Indexed = { app, name: field(app.name), slug: field(app.toolkit), category: field(app.category), about: squash(app.description ?? "") };
    entries.push(entry);

    const mask = maskOf(entry.name.text + entry.slug.text + entry.category.text + entry.about);
    letters[i] = mask.letters;
    digits[i] = mask.digits;
    if (!bySlug.has(app.toolkit)) bySlug.set(app.toolkit, app);
    for (const word of [entry.slug.text, entry.name.text]) if (word && !byWord.has(word)) byWord.set(word, app);
  });
  return { apps, bySlug, byWord, entries, letters, digits };
}

function spread(text: string, query: string): number {
  let first = -1;
  let at = 0;
  for (const letter of query) {
    const found = text.indexOf(letter, at);
    if (found < 0) return -1;
    if (first < 0) first = found;
    at = found + 1;
  }
  return at - 1 - first;
}

function scoreField(target: Field, query: string): number {
  const text = target.text;
  if (!query || !text) return 0;
  if (text === query) return 1000;
  if (text.startsWith(query)) return 800 - Math.min(text.length - query.length, 99);
  if (target.words.some((w) => w.startsWith(query))) return 600;
  const at = text.indexOf(query);
  if (at >= 0) return 500 - Math.min(at, 99);
  const run = spread(text, query);
  if (run >= 0) return Math.max(100, 300 - run);
  return 0;
}

export function fuzzyScore(query: string, text: string): number {
  return scoreField(field(text), squash(query));
}

function scoreEntry(entry: Indexed, query: string): number {
  const name = scoreField(entry.name, query);
  const slug = scoreField(entry.slug, query) * 0.95;
  const category = scoreField(entry.category, query) * 0.35;
  const about = entry.about.includes(query) ? 90 : 0;
  return Math.max(name, slug, category, about);
}

export function searchIndex(index: AppIndex, query: string): AppCatalogEntry[] {
  const q = squash(query);
  if (!q) return index.apps;
  const wanted = maskOf(q);
  const hits: { app: AppCatalogEntry; index: number; score: number }[] = [];
  for (let i = 0; i < index.entries.length; i++) {
    if ((wanted.letters & ~index.letters[i]!) !== 0 || (wanted.digits & ~index.digits[i]!) !== 0) continue;
    const entry = index.entries[i]!;
    const score = scoreEntry(entry, q);
    if (score > 0) hits.push({ app: entry.app, index: i, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.index - b.index).map((hit) => hit.app);
}

export function exactApp(index: AppIndex, query: string): AppCatalogEntry | null {
  return index.byWord.get(squash(query)) ?? null;
}

export function pageOf<T>(items: T[], page: number, per: number): { items: T[]; page: number; pages: number; total: number } {
  const size = Math.max(1, Math.floor(per));
  const pages = Math.max(1, Math.ceil(items.length / size));
  const at = Math.min(Math.max(Math.floor(page) || 1, 1), pages);
  return { items: items.slice((at - 1) * size, at * size), page: at, pages, total: items.length };
}
