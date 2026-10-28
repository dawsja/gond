import type { Blockquote, Nodes, PhrasingContent, Root, RootContent } from "mdast";
import { directiveFromMarkdown } from "mdast-util-directive";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { directive } from "micromark-extension-directive";
import { gfm } from "micromark-extension-gfm";

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

const TONES: readonly Tone[] = ["ok", "warn", "bad", "info", "neutral"];

export type Badge = { label: PhrasingContent[]; tone: Tone };

export type Meter = {
  value: number;
  max: number;
  percent: number;
  label: PhrasingContent[];
  text: string;
  left: string | null;
  right: string | null;
  tone: Tone;
};

export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";

type Callout = { kind: CalloutKind; children: RootContent[] };

export type Definitions = Map<string, { url: string; title: string | null }>;

// A single ~ would strike out everything between two shell prompts (`root@host:~#`) in pasted
// output; GitHub itself only strikes ~~two~~.
const extensions = [gfm({ singleTilde: false }), directive()];
const mdastExtensions = [gfmFromMarkdown(), directiveFromMarkdown()];

const TRAILING_CHOICES = /^(.*\S)[ \t]+(::choices\[[^\]\n]+\])[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CHOICES = /[ \t]*::choices\[[^\]\n]*\][ \t]*/g;

/**
 * The text as it is parsed. A bot sometimes ends its question with the
 * choices on the same line ("1 TB or 2? ::choices[1 TB | 2 TB]"), where a
 * leaf directive can't start, so they would show as raw text: such a line
 * is split so the choices stand on their own. Code fences are left alone.
 */
export function prepareMarkdown(source: string): string {
  let fence: string | null = null;
  return source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const open = FENCE.exec(line)?.[1];
      if (open && (!fence || open.startsWith(fence))) fence = fence ? null : open[0]!.repeat(3);
      const split = fence ? null : TRAILING_CHOICES.exec(line);
      return split ? `${split[1]}\n\n${split[2]}` : line;
    })
    .join("\n");
}

/**
 * A message as it is copied: its words without the choices, which are buttons under it on the page and
 * only directive syntax on a clipboard, wherever in the text they sit. Code fences are left alone.
 */
export function copyText(source: string): string {
  let fence: string | null = null;
  return source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const open = FENCE.exec(line)?.[1];
      if (open && (!fence || open.startsWith(fence))) {
        fence = fence ? null : open[0]!.repeat(3);
        return line;
      }
      if (fence || !line.includes("::choices[")) return line;
      const indent = /^[ \t]*/.exec(line)![0];
      return indent + line.replace(CHOICES, " ").trim();
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseMarkdown(source: string): Root {
  return fromMarkdown(prepareMarkdown(source), { extensions, mdastExtensions });
}

export function parseInline(source: string): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  const text = prepareMarkdown(source);
  for (const block of parseMarkdown(text).children) {
    if (out.length) out.push({ type: "text", value: "\n" });
    if (block.type === "paragraph" || block.type === "heading") out.push(...block.children);
    else out.push({ type: "text", value: sourceOf(block, text) });
  }
  return out;
}

export function sourceOf(node: Nodes, source: string): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? "" : source.slice(start, end);
}

export function safeHref(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null;
}

export const isLineBreak = (html: string) => /^<br\s*\/?>$/i.test(html.trim());

function toneOf(value: unknown): Tone | null {
  if (value === undefined || value === null || value === "") return "neutral";
  return typeof value === "string" && (TONES as readonly string[]).includes(value) ? (value as Tone) : null;
}

export function badgeOf(node: Nodes): Badge | null {
  if (node.type !== "textDirective" || node.name !== "badge") return null;
  const label = node.children;
  if (!plainText(label).trim()) return null;
  const tone = toneOf(node.attributes?.tone);
  return tone ? { label, tone } : null;
}

function numberOf(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const MAX_CHOICES = 6;
const MAX_CHOICE_LENGTH = 60;

/** `::choices[Pickup | Delivery]`: two to six short answers the person can tap instead of typing. */
export function choicesOf(node: Nodes): string[] | null {
  if (node.type !== "leafDirective" || node.name !== "choices") return null;
  const options = plainText(node.children)
    .split("|")
    .map((option) => option.trim())
    .filter(Boolean);
  if (options.length < 2 || options.length > MAX_CHOICES || options.some((option) => option.length > MAX_CHOICE_LENGTH)) return null;
  return [...new Set(options)];
}

export function meterOf(node: Nodes): Meter | null {
  if (node.type !== "leafDirective" || node.name !== "meter") return null;
  const attributes = node.attributes ?? {};
  const value = numberOf(attributes.value);
  if (value === null) return null;
  const max = attributes.max === undefined || attributes.max === null ? 100 : numberOf(attributes.max);
  if (max === null || max <= 0) return null;
  const tone = toneOf(attributes.tone);
  if (!tone) return null;
  const percent = Math.min(100, Math.max(0, (value / max) * 100));
  const text = attributes.text?.trim() || `${Math.round(percent)}%`;
  return {
    value,
    max,
    percent,
    label: parseInline(attributes.label ?? ""),
    text,
    left: attributes.left?.trim() || null,
    right: attributes.right?.trim() || null,
    tone,
  };
}

const CALLOUT = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;

export function calloutOf(node: Blockquote): Callout | null {
  const [first, ...rest] = node.children;
  if (first?.type !== "paragraph") return null;
  const [lead, ...others] = first.children;
  if (lead?.type !== "text") return null;
  const match = CALLOUT.exec(lead.value);
  if (!match) return null;
  const kind = match[1]!.toLowerCase() as CalloutKind;
  const value = lead.value.slice(match[0].length);
  const children: PhrasingContent[] = [...(value ? [{ type: "text", value } as PhrasingContent] : []), ...others];
  return { kind, children: children.length ? [{ ...first, children }, ...rest] : rest };
}

export function definitionsOf(root: Root): Definitions {
  const out: Definitions = new Map();
  const walk = (node: Nodes) => {
    if (node.type === "definition") out.set(node.identifier, { url: node.url, title: node.title ?? null });
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

const FLOW = new Set(["paragraph", "heading", "blockquote", "list", "listItem", "code", "table", "tableRow", "thematicBreak", "leafDirective", "containerDirective", "footnoteDefinition", "html"]);

function textOf(node: Nodes, source: string | undefined): string {
  const badge = badgeOf(node);
  if (badge) return plainText(badge.label, source);
  const meter = meterOf(node);
  if (meter) return `${plainText(meter.label, source)}: ${meter.text}\n`;
  const choices = choicesOf(node);
  if (choices) return `${choices.join(" or ")}?\n`;
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value;
    case "code":
      return `${node.value}\n`;
    case "html":
      return isLineBreak(node.value) ? "\n" : node.value;
    case "break":
      return "\n";
    case "image":
    case "imageReference":
      return node.alt ?? "";
    case "tableCell":
      return `${plainChildren(node, source)} `;
    case "thematicBreak":
    case "definition":
    case "yaml":
      return "";
    case "textDirective":
    case "leafDirective":
    case "containerDirective":
    case "footnoteReference":
    case "footnoteDefinition":
      return source ? `${sourceOf(node, source)}${FLOW.has(node.type) ? "\n" : ""}` : plainChildren(node, source);
    default: {
      const inner = plainChildren(node, source);
      return FLOW.has(node.type) ? `${inner.replace(/\n+$/, "")}\n` : inner;
    }
  }
}

function plainChildren(node: Nodes, source: string | undefined): string {
  return "children" in node ? node.children.map((child) => textOf(child, source)).join("") : "";
}

export function plainText(input: Nodes | Nodes[], source?: string): string {
  const nodes = Array.isArray(input) ? input : [input];
  return nodes
    .map((node) => textOf(node, source))
    .join("")
    .replace(/\n+$/, "");
}
