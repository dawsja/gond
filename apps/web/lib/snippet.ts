import { plainMarkdown, type Message } from "@gond/shared";

export type Snippet = { before: string; match: string; after: string };

const SIDE = 40;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function find(text: string, needle: string): { at: number; length: number } | null {
  if (!needle) return null;
  const found = new RegExp(escape(needle), "iu").exec(text);
  return found ? { at: found.index, length: found[0].length } : null;
}

function tail(text: string): string {
  if (text.length <= SIDE) return text;
  let cut = text.slice(text.length - SIDE);
  if (!/\s/.test(text[text.length - SIDE - 1] ?? "")) {
    const space = cut.search(/\s/);
    if (space >= 0) cut = cut.slice(space);
  }
  return `…${cut.trimStart()}`;
}

function head(text: string, size = SIDE): string {
  if (text.length <= size) return text;
  let cut = text.slice(0, size);
  if (!/\s/.test(text[size] ?? "")) {
    const space = cut.search(/\s\S*$/);
    if (space > 0) cut = cut.slice(0, space);
  }
  return `${cut.trimEnd()}…`;
}

/** The words around a search's first match in a message: the whole query, else its first word, cut on word boundaries. */
export function matchSnippet(text: string, query: string): Snippet {
  const plain = text.replace(/\s+/g, " ").trim();
  const words = query.trim().split(/\s+/).filter(Boolean);
  const hit = find(plain, words.join(" ")) ?? find(plain, words[0] ?? "");
  if (!hit) return { before: "", match: "", after: head(plain, SIDE * 2) };
  return {
    before: tail(plain.slice(0, hit.at)),
    match: plain.slice(hit.at, hit.at + hit.length),
    after: head(plain.slice(hit.at + hit.length)),
  };
}

/** What a search hit shows: its words as plain text, or its first file's name when it has none. */
export function messageSnippet(message: Pick<Message, "body" | "attachments">, query: string): Snippet {
  return matchSnippet(plainMarkdown(message.body) || message.attachments[0]?.name || "", query);
}
