import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { lexComments } from "./lexers.ts";
import type { CommentKind, ExemptReason, Language, RawComment, TextSpan } from "./types.ts";

const SPDX_PATTERN = /SPDX-License-Identifier:|SPDX-FileCopyrightText:/i;

const LICENSE_PROSE_PATTERN =
  /\b(?:copyright|licensed under|mit license|apache license|open font license|permission is hereby granted|all rights reserved|mozilla public license|gnu general public license)\b/i;

const OPENAPI_PATTERN = /(?:^|[\s*])@(?:openapi|swagger)(?:\b|$)/i;

const DIRECTIVE_PATTERN =
  /^(?:eslint-disable(?:-next-line|-line)?(?:\s|$)|eslint-enable(?:\s|$)|@ts-(?:expect-error|ignore|nocheck|check)(?:\b|$)|prettier-ignore(?:-start|-end)?(?:\b|$)|biome-ignore(?:\b|$)|oxlint-disable(?:-next-line|-line)?(?:\b|$)|stylelint-disable(?:-next-line|-line)?(?:\b|$)|stylelint-enable(?:\b|$)|ktlint-disable(?:\b|$)|ktlint-enable(?:\b|$)|swiftlint:|swift-format-ignore(?:-file)?(?:\b|$)|shellcheck\s+|yamllint\s+|yaml-language-server:|noinspection\b|[#@]__PURE__\b|[#@]__NO_SIDE_EFFECTS__\b|@vite-ignore\b|webpackChunkName\s*:|webpackIgnore\s*:|webpackMode\s*:|webpackPreload\s*:|webpackPrefetch\s*:|istanbul\s+ignore\b|c8\s+ignore\b|v8\s+ignore\b|#region\b|#endregion\b)/;

const BLOCK_ESLINT_PATTERN = /^(?:eslint|global|exported)\s+/;

const JSX_PRAGMA_PATTERN = /^@jsx(?:ImportSource|Frag|Runtime)?(?:\s|$)/;

const MISSING_DOCS_PATTERN = /#!\[\s*(?:warn|deny)\s*\([^)]*\bmissing_docs\b[^)]*\)\s*\]/;

export interface GroupedComment {
  language: Language;
  kind: CommentKind;
  prefix: string;
  start: number;
  end: number;
  removalStart: number;
  removalEnd: number;
  startLine: number;
  endLine: number;
  inline: boolean;
  text: string;
  normalizedText: string;
  hash: string;
  preview: string;
  exempt: ExemptReason | null;
  spans: TextSpan[];
}

export function stripTokenDelimiters(token: RawComment): string {
  const normalized = token.text.replace(/\r\n/g, "\n");
  if (token.isLineComment) {
    return normalized.slice(token.prefix.length).trim();
  }
  let inner = normalized;
  if (inner.startsWith("<!--")) {
    inner = inner.slice(4);
    if (inner.endsWith("-->")) {
      inner = inner.slice(0, -3);
    }
  } else if (inner.startsWith("/**") && inner !== "/**/") {
    inner = inner.slice(3);
    if (inner.endsWith("*/")) {
      inner = inner.slice(0, -2);
    }
  } else if (inner.startsWith("/*!")) {
    inner = inner.slice(3);
    if (inner.endsWith("*/")) {
      inner = inner.slice(0, -2);
    }
  } else if (inner.startsWith("/*")) {
    inner = inner.slice(2);
    if (inner.endsWith("*/")) {
      inner = inner.slice(0, -2);
    }
  }
  return inner
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}

function directiveBody(token: RawComment): string {
  const stripped = stripTokenDelimiters(token);
  if (token.isLineComment) return stripped;
  const lines = stripped
    .split("\n")
    .map((line) => line.replace(/^\*+\s?/, "").trim())
    .filter((line) => line.length > 0);
  return lines.join("\n");
}

export function normalizeCommentTokens(tokens: RawComment[]): string {
  return tokens.map(stripTokenDelimiters).join("\n");
}

export function computeCommentHash(kind: CommentKind, normalizedText: string): string {
  return createHash("sha256").update(`${kind}\0${normalizedText}`).digest("hex").slice(0, 16);
}

export function makeCommentPreview(normalizedText: string): string {
  const flat = normalizedText.replace(/\s+/g, " ").trim();
  if (flat.length <= 80) return flat;
  return `${flat.slice(0, 77)}...`;
}

function computeBeforeCodeFlags(source: string, tokens: RawComment[], fileLanguage: Language): boolean[] {
  const flags: boolean[] = new Array(tokens.length).fill(false);
  let cursor = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let gap = source.slice(cursor, token.removalStart);
    if (cursor === 0 && gap.startsWith("\uFEFF")) {
      gap = gap.slice(1);
    }
    if (fileLanguage === "xml" || fileLanguage === "html") {
      gap = gap.replace(/^\s*(?:<\?xml[\s\S]*?\?>\s*)*/i, "");
    }
    if (gap.trim().length > 0) {
      break;
    }
    flags[i] = true;
    cursor = token.removalEnd;
  }
  return flags;
}

function isJsFamily(language: Language): boolean {
  return language === "ts" || language === "tsx" || language === "js" || language === "jsx";
}

function isDirectiveToken(token: RawComment, beforeCode: boolean): boolean {
  if (token.prefix === "#!" && token.startLine === 1) {
    return true;
  }
  const body = directiveBody(token);
  if (token.language === "dockerfile" && beforeCode && /^(?:syntax|escape|check)\s*=/i.test(body)) {
    return true;
  }
  if (token.language === "swift" && /^\s*\/\/\s*MARK:/.test(token.text)) {
    return true;
  }
  if (token.prefix === "///" && /^<reference\s+[^>]+\/>/i.test(body)) {
    return true;
  }
  if (DIRECTIVE_PATTERN.test(body)) {
    return true;
  }
  if (!token.isLineComment && isJsFamily(token.language) && BLOCK_ESLINT_PATTERN.test(body)) {
    return true;
  }
  if (isJsFamily(token.language) && JSX_PRAGMA_PATTERN.test(body)) {
    return true;
  }
  return false;
}

function isApiDocToken(token: RawComment, rustRequiresMissingDocs: boolean): boolean {
  if (OPENAPI_PATTERN.test(token.text)) {
    return true;
  }
  if (
    rustRequiresMissingDocs &&
    token.language === "rust" &&
    (token.prefix === "///" || token.prefix === "//!" || token.prefix === "/**" || token.prefix === "/*!")
  ) {
    return true;
  }
  return false;
}

function isSpdxToken(token: RawComment): boolean {
  return SPDX_PATTERN.test(token.text);
}

function classifyRawToken(token: RawComment, beforeCode: boolean, rustRequiresMissingDocs: boolean): ExemptReason | null {
  if (isDirectiveToken(token, beforeCode)) {
    return "directive";
  }
  if (isSpdxToken(token)) {
    return "license";
  }
  if (beforeCode && LICENSE_PROSE_PATTERN.test(token.text)) {
    return "license";
  }
  if (isApiDocToken(token, rustRequiresMissingDocs)) {
    return "api-doc";
  }
  return null;
}

interface AnnotatedToken {
  token: RawComment;
  beforeCode: boolean;
  isSpdx: boolean;
  rawExempt: ExemptReason | null;
}

function canMergeLineTokens(prev: AnnotatedToken, next: AnnotatedToken): boolean {
  if (!prev.token.isLineComment || !next.token.isLineComment) return false;
  if (!prev.token.standalone || !next.token.standalone) return false;
  if (prev.token.endLine + 1 !== next.token.startLine) return false;
  if (prev.token.column !== next.token.column) return false;
  if (prev.token.prefix !== next.token.prefix) return false;
  if (prev.token.language !== next.token.language) return false;
  if (prev.rawExempt === "directive" || next.rawExempt === "directive") return false;
  if ((prev.rawExempt === "api-doc") !== (next.rawExempt === "api-doc")) return false;
  if (prev.isSpdx || next.isSpdx) {
    return prev.isSpdx && next.isSpdx;
  }
  return true;
}

export function classifyAndGroupComments(
  source: string,
  fileLanguage: Language,
  rawTokens: RawComment[],
  rustRequiresMissingDocs = false,
): GroupedComment[] {
  if (rawTokens.length === 0) return [];
  const beforeCodeFlags = computeBeforeCodeFlags(source, rawTokens, fileLanguage);
  const annotated: AnnotatedToken[] = rawTokens.map((token, idx) => ({
    token,
    beforeCode: beforeCodeFlags[idx],
    isSpdx: isSpdxToken(token),
    rawExempt: classifyRawToken(token, beforeCodeFlags[idx], rustRequiresMissingDocs),
  }));

  const groups: AnnotatedToken[][] = [];
  for (const item of annotated) {
    const currentGroup = groups[groups.length - 1];
    if (currentGroup && canMergeLineTokens(currentGroup[currentGroup.length - 1], item)) {
      currentGroup.push(item);
    } else {
      groups.push([item]);
    }
  }

  return groups.map((group) => {
    const first = group[0].token;
    const last = group[group.length - 1].token;
    const tokens = group.map((g) => g.token);
    const normalizedText = normalizeCommentTokens(tokens);
    const allBeforeCode = group.every((g) => g.beforeCode);
    const combinedText = source.slice(first.start, last.end);

    let exempt: ExemptReason | null = null;
    if (group.length === 1) {
      exempt = group[0].rawExempt;
    } else if (group.every((g) => g.rawExempt === "api-doc")) {
      exempt = "api-doc";
    } else if (group.every((g) => g.isSpdx)) {
      exempt = "license";
    } else if (allBeforeCode && LICENSE_PROSE_PATTERN.test(combinedText)) {
      exempt = "license";
    }

    const kind = first.kind;
    return {
      language: first.language,
      kind,
      prefix: first.prefix,
      start: first.start,
      end: last.end,
      removalStart: first.removalStart,
      removalEnd: last.removalEnd,
      startLine: first.startLine,
      endLine: last.endLine,
      inline: group.some((g) => g.token.inline),
      text: combinedText,
      normalizedText,
      hash: computeCommentHash(kind, normalizedText),
      preview: makeCommentPreview(normalizedText),
      exempt,
      spans: tokens.map((t) => ({ start: t.removalStart, end: t.removalEnd })),
    };
  });
}

function stripRustComments(source: string): string {
  const comments = lexComments(source, "rust");
  if (comments.length === 0) return source;
  let out = "";
  let cursor = 0;
  for (const comment of comments) {
    out += source.slice(cursor, comment.start);
    cursor = comment.end;
  }
  out += source.slice(cursor);
  return out;
}

export function rustSourceRequiresMissingDocs(source: string): boolean {
  if (!source.includes("missing_docs")) return false;
  return MISSING_DOCS_PATTERN.test(stripRustComments(source));
}

export function createRustMissingDocsChecker(root: string): (absPath: string, source: string) => Promise<boolean> {
  const resolvedRoot = resolve(root);
  const crateCache = new Map<string, boolean>();

  async function findCrateRoot(startDir: string): Promise<string | null> {
    let dir = resolve(startDir);
    while (true) {
      if (await Bun.file(join(dir, "Cargo.toml")).exists()) {
        return dir;
      }
      if (dir === resolvedRoot) return null;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  async function crateRequiresMissingDocs(crateDir: string): Promise<boolean> {
    const cached = crateCache.get(crateDir);
    if (cached !== undefined) return cached;
    for (const entry of ["src/lib.rs", "src/main.rs"]) {
      const candidate = join(crateDir, entry);
      if (await Bun.file(candidate).exists()) {
        try {
          const content = await readFile(candidate, "utf8");
          if (rustSourceRequiresMissingDocs(content)) {
            crateCache.set(crateDir, true);
            return true;
          }
        } catch {
          continue;
        }
      }
    }
    crateCache.set(crateDir, false);
    return false;
  }

  return async (absPath: string, source: string): Promise<boolean> => {
    if (rustSourceRequiresMissingDocs(source)) return true;
    const crateDir = await findCrateRoot(dirname(absPath));
    if (!crateDir) return false;
    return crateRequiresMissingDocs(crateDir);
  };
}
