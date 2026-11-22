import { lexTypeScriptComments } from "./ts-lexer.ts";
import {
  buildLineIndex,
  lineBounds,
  makeRawComment,
  offsetToLineCol,
  type CommentKind,
  type Language,
  type RawComment,
} from "./types.ts";

function isAsciiIdentChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function isCssIdentChar(code: number): boolean {
  return isAsciiIdentChar(code) || code === 45;
}

function findLineEnd(source: string, from: number): number {
  let i = from;
  while (i < source.length && source.charCodeAt(i) !== 10) {
    i++;
  }
  return i;
}

function scanNestedBlockComment(source: string, start: number): number {
  let i = start + 2;
  let depth = 1;
  while (i < source.length && depth > 0) {
    if (source.charCodeAt(i) === 47 && source.charCodeAt(i + 1) === 42) {
      depth++;
      i += 2;
    } else if (source.charCodeAt(i) === 42 && source.charCodeAt(i + 1) === 47) {
      depth--;
      i += 2;
    } else {
      i++;
    }
  }
  return i;
}

function scanSimpleBlockComment(source: string, start: number): number {
  const close = source.indexOf("*/", start + 2);
  return close === -1 ? source.length : close + 2;
}

interface SwiftInterpFrame {
  hashes: number;
  multiline: boolean;
  parenDepth: number;
}

function lexSwiftComments(source: string): RawComment[] {
  const lineStarts = buildLineIndex(source);
  const comments: RawComment[] = [];
  const stack: SwiftInterpFrame[] = [];
  let i = 0;
  const len = source.length;

  if (source.startsWith("#!")) {
    const end = findLineEnd(source, 0);
    comments.push(
      makeRawComment(source, lineStarts, {
        start: 0,
        end,
        kind: "line",
        prefix: "#!",
        language: "swift",
        isLineComment: true,
      }),
    );
    i = end;
  }

  function scanStringBody(hashes: number, multiline: boolean): void {
    while (i < len) {
      const ch = source.charCodeAt(i);
      if (ch === 92) {
        let h = 0;
        while (h < hashes && source.charCodeAt(i + 1 + h) === 35) {
          h++;
        }
        if (h === hashes) {
          const after = i + 1 + hashes;
          if (source.charCodeAt(after) === 40) {
            i = after + 1;
            stack.push({ hashes, multiline, parenDepth: 1 });
            return;
          }
          i = Math.min(after + 1, len);
          continue;
        }
        i++;
        continue;
      }

      if (multiline) {
        if (source.startsWith('"""', i)) {
          let h = 0;
          while (h < hashes && source.charCodeAt(i + 3 + h) === 35) {
            h++;
          }
          if (h === hashes) {
            i += 3 + hashes;
            return;
          }
        }
        i++;
        continue;
      }

      if (ch === 34) {
        let h = 0;
        while (h < hashes && source.charCodeAt(i + 1 + h) === 35) {
          h++;
        }
        if (h === hashes) {
          i += 1 + hashes;
          return;
        }
      } else if (ch === 10) {
        i++;
        return;
      }
      i++;
    }
  }

  while (i < len) {
    const ch = source.charCodeAt(i);

    if (ch === 47 && source.charCodeAt(i + 1) === 47) {
      const start = i;
      const end = findLineEnd(source, i + 2);
      const isDoc = source.charCodeAt(start + 2) === 47 && source.charCodeAt(start + 3) !== 47;
      comments.push(
        makeRawComment(source, lineStarts, {
          start,
          end,
          kind: isDoc ? "doc" : "line",
          prefix: isDoc ? "///" : "//",
          language: "swift",
          isLineComment: true,
        }),
      );
      i = end;
      continue;
    }

    if (ch === 47 && source.charCodeAt(i + 1) === 42) {
      const start = i;
      const end = scanNestedBlockComment(source, start);
      const text = source.slice(start, end);
      const isDoc = text.startsWith("/**") && text !== "/**/" && !text.startsWith("/***");
      comments.push(
        makeRawComment(source, lineStarts, {
          start,
          end,
          kind: isDoc ? "doc" : "block",
          prefix: isDoc ? "/**" : "/*",
          language: "swift",
          isLineComment: false,
        }),
      );
      i = end;
      continue;
    }

    if (ch === 35) {
      let hashes = 0;
      while (source.charCodeAt(i + hashes) === 35) {
        hashes++;
      }
      const next = i + hashes;
      if (source.startsWith('"""', next)) {
        i = next + 3;
        scanStringBody(hashes, true);
        continue;
      }
      if (source.charCodeAt(next) === 34) {
        i = next + 1;
        scanStringBody(hashes, false);
        continue;
      }
      if (source.charCodeAt(next) === 47) {
        i = next + 1;
        while (i < len) {
          if (source.charCodeAt(i) === 47) {
            let h = 0;
            while (h < hashes && source.charCodeAt(i + 1 + h) === 35) {
              h++;
            }
            if (h === hashes) {
              i += 1 + hashes;
              break;
            }
          }
          i++;
        }
        continue;
      }
      i = next;
      continue;
    }

    if (ch === 34) {
      if (source.startsWith('"""', i)) {
        i += 3;
        scanStringBody(0, true);
        continue;
      }
      i++;
      scanStringBody(0, false);
      continue;
    }

    if (stack.length > 0) {
      if (ch === 40) {
        stack[stack.length - 1].parenDepth++;
        i++;
        continue;
      }
      if (ch === 41) {
        const top = stack[stack.length - 1];
        top.parenDepth--;
        i++;
        if (top.parenDepth === 0) {
          stack.pop();
          scanStringBody(top.hashes, top.multiline);
        }
        continue;
      }
    }

    i++;
  }

  return comments;
}

interface KotlinInterpFrame {
  raw: boolean;
  braceDepth: number;
}

function lexKotlinComments(source: string): RawComment[] {
  const lineStarts = buildLineIndex(source);
  const comments: RawComment[] = [];
  const stack: KotlinInterpFrame[] = [];
  let i = 0;
  const len = source.length;

  if (source.startsWith("#!")) {
    const end = findLineEnd(source, 0);
    comments.push(
      makeRawComment(source, lineStarts, {
        start: 0,
        end,
        kind: "line",
        prefix: "#!",
        language: "kotlin",
        isLineComment: true,
      }),
    );
    i = end;
  }

  function scanKotlinStringBody(raw: boolean): void {
    while (i < len) {
      const ch = source.charCodeAt(i);
      if (raw) {
        if (ch === 36 && source.charCodeAt(i + 1) === 123) {
          i += 2;
          stack.push({ raw: true, braceDepth: 1 });
          return;
        }
        if (source.startsWith('"""', i)) {
          while (source.charCodeAt(i + 3) === 34) {
            i++;
          }
          i += 3;
          return;
        }
        i++;
        continue;
      }

      if (ch === 92) {
        i = Math.min(i + 2, len);
        continue;
      }
      if (ch === 36 && source.charCodeAt(i + 1) === 123) {
        i += 2;
        stack.push({ raw: false, braceDepth: 1 });
        return;
      }
      if (ch === 34 || ch === 10) {
        i++;
        return;
      }
      i++;
    }
  }

  while (i < len) {
    const ch = source.charCodeAt(i);

    if (ch === 47 && source.charCodeAt(i + 1) === 47) {
      const start = i;
      const end = findLineEnd(source, i + 2);
      const isTriple = source.charCodeAt(start + 2) === 47 && source.charCodeAt(start + 3) !== 47;
      comments.push(
        makeRawComment(source, lineStarts, {
          start,
          end,
          kind: "line",
          prefix: isTriple ? "///" : "//",
          language: "kotlin",
          isLineComment: true,
        }),
      );
      i = end;
      continue;
    }

    if (ch === 47 && source.charCodeAt(i + 1) === 42) {
      const start = i;
      const end = scanNestedBlockComment(source, start);
      const text = source.slice(start, end);
      const isDoc = text.startsWith("/**") && text !== "/**/";
      comments.push(
        makeRawComment(source, lineStarts, {
          start,
          end,
          kind: isDoc ? "doc" : "block",
          prefix: isDoc ? "/**" : "/*",
          language: "kotlin",
          isLineComment: false,
        }),
      );
      i = end;
      continue;
    }

    if (ch === 34) {
      if (source.startsWith('"""', i)) {
        i += 3;
        scanKotlinStringBody(true);
        continue;
      }
      i++;
      scanKotlinStringBody(false);
      continue;
    }

    if (ch === 39) {
      i++;
      while (i < len) {
        const c = source.charCodeAt(i);
        if (c === 92) {
          i = Math.min(i + 2, len);
          continue;
        }
        i++;
        if (c === 39 || c === 10) break;
      }
      continue;
    }

    if (ch === 96) {
      i++;
      while (i < len) {
        const c = source.charCodeAt(i);
        i++;
        if (c === 96 || c === 10) break;
      }
      continue;
    }

    if (stack.length > 0) {
      if (ch === 123) {
        stack[stack.length - 1].braceDepth++;
        i++;
        continue;
      }
      if (ch === 125) {
        const top = stack[stack.length - 1];
        top.braceDepth--;
        i++;
        if (top.braceDepth === 0) {
          stack.pop();
          scanKotlinStringBody(top.raw);
        }
        continue;
      }
    }

    i++;
  }

  return comments;
}

function lexRustComments(source: string): RawComment[] {
  const lineStarts = buildLineIndex(source);
  const comments: RawComment[] = [];
  let i = 0;
  const len = source.length;

  if (source.startsWith("#!") && source.charCodeAt(2) !== 91) {
    const end = findLineEnd(source, 0);
    comments.push(
      makeRawComment(source, lineStarts, {
        start: 0,
        end,
        kind: "line",
        prefix: "#!",
        language: "rust",
        isLineComment: true,
      }),
    );
    i = end;
  }

  function tryScanRawString(prefixStart: number, rPos: number): boolean {
    if (prefixStart > 0 && isAsciiIdentChar(source.charCodeAt(prefixStart - 1))) {
      return false;
    }
    let hashes = 0;
    let p = rPos + 1;
    while (p < len && source.charCodeAt(p) === 35) {
      hashes++;
      p++;
    }
    if (source.charCodeAt(p) !== 34) {
      return false;
    }
    i = p + 1;
    while (i < len) {
      if (source.charCodeAt(i) === 34) {
        let h = 0;
        while (h < hashes && source.charCodeAt(i + 1 + h) === 35) {
          h++;
        }
        if (h === hashes) {
          i += 1 + hashes;
          return true;
        }
      }
      i++;
    }
    return true;
  }

  function scanQuotedString(openQuotePos: number): void {
    i = openQuotePos + 1;
    while (i < len) {
      const c = source.charCodeAt(i);
      if (c === 92) {
        i = Math.min(i + 2, len);
        continue;
      }
      i++;
      if (c === 34) return;
    }
  }

  function tryScanCharLiteral(quotePos: number): boolean {
    if (quotePos + 1 >= len) return false;
    const next = source.charCodeAt(quotePos + 1);
    if (next === 92) {
      let p = quotePos + 3;
      const limit = Math.min(len, quotePos + 20);
      while (p < limit) {
        const c = source.charCodeAt(p);
        if (c === 39) {
          i = p + 1;
          return true;
        }
        if (c === 10 || c === 13) return false;
        p++;
      }
      return false;
    }
    if (next === 39 || next === 10 || next === 13) {
      return false;
    }
    const cp = source.codePointAt(quotePos + 1) ?? 0;
    const step = cp > 0xffff ? 2 : 1;
    if (source.charCodeAt(quotePos + 1 + step) === 39) {
      i = quotePos + 2 + step;
      return true;
    }
    return false;
  }

  while (i < len) {
    const ch = source.charCodeAt(i);

    if (ch === 47 && source.charCodeAt(i + 1) === 47) {
      const start = i;
      const end = findLineEnd(source, i + 2);
      const third = source.charCodeAt(start + 2);
      const fourth = source.charCodeAt(start + 3);
      let kind: CommentKind = "line";
      let prefix = "//";
      if (third === 47 && fourth !== 47) {
        kind = "doc";
        prefix = "///";
      } else if (third === 33) {
        kind = "doc";
        prefix = "//!";
      }
      comments.push(
        makeRawComment(source, lineStarts, {
          start,
          end,
          kind,
          prefix,
          language: "rust",
          isLineComment: true,
        }),
      );
      i = end;
      continue;
    }

    if (ch === 47 && source.charCodeAt(i + 1) === 42) {
      const start = i;
      const end = scanNestedBlockComment(source, start);
      const text = source.slice(start, end);
      let kind: CommentKind = "block";
      let prefix = "/*";
      if (text.startsWith("/**") && text !== "/**/" && !text.startsWith("/***")) {
        kind = "doc";
        prefix = "/**";
      } else if (text.startsWith("/*!")) {
        kind = "doc";
        prefix = "/*!";
      }
      comments.push(
        makeRawComment(source, lineStarts, {
          start,
          end,
          kind,
          prefix,
          language: "rust",
          isLineComment: false,
        }),
      );
      i = end;
      continue;
    }

    if (ch === 114 && tryScanRawString(i, i)) {
      continue;
    }

    if ((ch === 98 || ch === 99) && (i === 0 || !isAsciiIdentChar(source.charCodeAt(i - 1)))) {
      const next = source.charCodeAt(i + 1);
      if (next === 114 && tryScanRawString(i, i + 1)) {
        continue;
      }
      if (next === 34) {
        scanQuotedString(i + 1);
        continue;
      }
      if (ch === 98 && next === 39 && tryScanCharLiteral(i + 1)) {
        continue;
      }
    }

    if (ch === 34) {
      scanQuotedString(i);
      continue;
    }

    if (ch === 39 && tryScanCharLiteral(i)) {
      continue;
    }

    i++;
  }

  return comments;
}

function lexCssComments(source: string): RawComment[] {
  const lineStarts = buildLineIndex(source);
  const comments: RawComment[] = [];
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source.charCodeAt(i);

    if (ch === 47 && source.charCodeAt(i + 1) === 42) {
      const start = i;
      const end = scanSimpleBlockComment(source, start);
      comments.push(
        makeRawComment(source, lineStarts, {
          start,
          end,
          kind: "block",
          prefix: "/*",
          language: "css",
          isLineComment: false,
        }),
      );
      i = end;
      continue;
    }

    if (ch === 34 || ch === 39) {
      const quote = ch;
      i++;
      while (i < len) {
        const c = source.charCodeAt(i);
        if (c === 92) {
          i = Math.min(i + 2, len);
          continue;
        }
        i++;
        if (c === quote) break;
      }
      continue;
    }

    if (
      (ch === 117 || ch === 85) &&
      (i === 0 || !isCssIdentChar(source.charCodeAt(i - 1))) &&
      source.slice(i, i + 4).toLowerCase() === "url("
    ) {
      let p = i + 4;
      while (p < len && (source.charCodeAt(p) === 32 || source.charCodeAt(p) === 9 || source.charCodeAt(p) === 10 || source.charCodeAt(p) === 13)) {
        p++;
      }
      const next = source.charCodeAt(p);
      if (next !== 34 && next !== 39) {
        i = p;
        while (i < len) {
          const c = source.charCodeAt(i);
          if (c === 92) {
            i = Math.min(i + 2, len);
            continue;
          }
          i++;
          if (c === 41) break;
        }
        continue;
      }
      i = p;
      continue;
    }

    i++;
  }

  return comments;
}

function findTagClose(source: string, openPos: number): { closePos: number; selfClosing: boolean; attrs: string } {
  let i = openPos;
  const len = source.length;
  while (i < len) {
    const ch = source.charCodeAt(i);
    if (ch === 34 || ch === 39) {
      const quote = ch;
      i++;
      while (i < len && source.charCodeAt(i) !== quote) {
        i++;
      }
      if (i < len) i++;
      continue;
    }
    if (ch === 62) {
      const attrs = source.slice(openPos, i);
      const trimmed = attrs.trimEnd();
      return { closePos: i, selfClosing: trimmed.endsWith("/"), attrs };
    }
    i++;
  }
  return { closePos: len, selfClosing: false, attrs: source.slice(openPos) };
}

function extractHtmlAttr(attrs: string, name: string): string | null {
  const regex = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + "`" + `]+))`, "i");
  const match = regex.exec(attrs);
  if (!match) return null;
  return (match[1] ?? match[2] ?? match[3] ?? "").trim();
}

function isJavaScriptMimeType(typeValue: string | null): boolean {
  if (typeValue === null || typeValue === "") return true;
  const normalized = typeValue.split(";")[0].trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "module" ||
    normalized === "text/javascript" ||
    normalized === "application/javascript" ||
    normalized === "text/ecmascript" ||
    normalized === "application/ecmascript" ||
    normalized === "text/jscript" ||
    normalized === "application/x-javascript"
  );
}

function findClosingRawTag(source: string, from: number, tagName: string): { contentEnd: number; tagEnd: number } {
  const lower = source.toLowerCase();
  const needle = `</${tagName}`;
  let pos = from;
  while (pos < source.length) {
    const idx = lower.indexOf(needle, pos);
    if (idx === -1) {
      return { contentEnd: source.length, tagEnd: source.length };
    }
    const after = idx + needle.length;
    const ch = source.charCodeAt(after);
    if (after >= source.length || ch === 62 || ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 47) {
      const close = source.indexOf(">", after);
      return { contentEnd: idx, tagEnd: close === -1 ? source.length : close + 1 };
    }
    pos = after;
  }
  return { contentEnd: source.length, tagEnd: source.length };
}

function rebaseComments(source: string, lineStarts: number[], embedded: RawComment[], offset: number): RawComment[] {
  return embedded.map((comment) =>
    makeRawComment(source, lineStarts, {
      start: comment.start + offset,
      end: comment.end + offset,
      removalStart: comment.removalStart + offset,
      removalEnd: comment.removalEnd + offset,
      kind: comment.kind,
      prefix: comment.prefix,
      language: comment.language,
      isLineComment: comment.isLineComment,
    }),
  );
}

function lexHtmlComments(source: string): RawComment[] {
  const lineStarts = buildLineIndex(source);
  const comments: RawComment[] = [];
  let i = 0;
  const len = source.length;

  while (i < len) {
    if (source.charCodeAt(i) !== 60) {
      i++;
      continue;
    }

    if (source.startsWith("<!--", i)) {
      const start = i;
      let end: number;
      if (source.startsWith("<!-->", i)) {
        end = i + 5;
      } else if (source.startsWith("<!--->", i)) {
        end = i + 6;
      } else {
        const close = source.indexOf("-->", i + 4);
        end = close === -1 ? len : close + 3;
      }
      comments.push(
        makeRawComment(source, lineStarts, {
          start,
          end,
          kind: "html",
          prefix: "<!--",
          language: "html",
          isLineComment: false,
        }),
      );
      i = end;
      continue;
    }

    if (source.startsWith("<![CDATA[", i)) {
      const close = source.indexOf("]]>", i + 9);
      i = close === -1 ? len : close + 3;
      continue;
    }

    if (source.startsWith("<?", i)) {
      const close = source.indexOf(">", i + 2);
      i = close === -1 ? len : close + 1;
      continue;
    }

    const tagMatch = /^<([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>]|$)/.exec(source.slice(i, i + 64));
    if (tagMatch) {
      const tagName = tagMatch[1].toLowerCase();
      const { closePos, selfClosing, attrs } = findTagClose(source, i + 1 + tagMatch[1].length);
      if (closePos >= len) {
        break;
      }
      const bodyStart = closePos + 1;
      if (!selfClosing && (tagName === "script" || tagName === "style")) {
        const { contentEnd, tagEnd } = findClosingRawTag(source, bodyStart, tagName);
        const body = source.slice(bodyStart, contentEnd);
        if (tagName === "script") {
          const typeAttr = extractHtmlAttr(attrs, "type");
          if (isJavaScriptMimeType(typeAttr) && body.trim().length > 0) {
            comments.push(...rebaseComments(source, lineStarts, lexTypeScriptComments(body, "js"), bodyStart));
          }
        } else if (body.trim().length > 0) {
          comments.push(...rebaseComments(source, lineStarts, lexCssComments(body), bodyStart));
        }
        i = tagEnd;
        continue;
      }
      i = bodyStart;
      continue;
    }

    if (source.startsWith("<!", i) || source.startsWith("</", i)) {
      const { closePos } = findTagClose(source, i + 2);
      i = Math.min(closePos + 1, len);
      continue;
    }

    i++;
  }

  return comments;
}

function lexXmlComments(source: string): RawComment[] {
  const lineStarts = buildLineIndex(source);
  const comments: RawComment[] = [];
  let i = 0;
  const len = source.length;

  while (i < len) {
    if (source.charCodeAt(i) !== 60) {
      i++;
      continue;
    }

    if (source.startsWith("<!--", i)) {
      const start = i;
      const close = source.indexOf("-->", i + 4);
      const end = close === -1 ? len : close + 3;
      comments.push(
        makeRawComment(source, lineStarts, {
          start,
          end,
          kind: "html",
          prefix: "<!--",
          language: "xml",
          isLineComment: false,
        }),
      );
      i = end;
      continue;
    }

    if (source.startsWith("<![CDATA[", i)) {
      const close = source.indexOf("]]>", i + 9);
      i = close === -1 ? len : close + 3;
      continue;
    }

    if (source.startsWith("<?", i)) {
      const close = source.indexOf("?>", i + 2);
      i = close === -1 ? len : close + 2;
      continue;
    }

    if (source.slice(i, i + 9).toUpperCase() === "<!DOCTYPE") {
      i += 9;
      let bracketDepth = 0;
      while (i < len) {
        const c = source.charCodeAt(i);
        if (c === 34 || c === 39) {
          const quote = c;
          i++;
          while (i < len && source.charCodeAt(i) !== quote) i++;
          if (i < len) i++;
          continue;
        }
        if (c === 91) {
          bracketDepth++;
        } else if (c === 93 && bracketDepth > 0) {
          bracketDepth--;
        } else if (c === 62 && bracketDepth === 0) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    const next = source.charCodeAt(i + 1);
    if ((next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 95 || next === 47 || next === 33) {
      const { closePos } = findTagClose(source, i + 1);
      i = Math.min(closePos + 1, len);
      continue;
    }

    i++;
  }

  return comments;
}

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
}

export function lexShellComments(source: string, allowShebang = true): RawComment[] {
  const lineStarts = buildLineIndex(source);
  const comments: RawComment[] = [];
  const pendingHeredocs: PendingHeredoc[] = [];
  let i = 0;
  const len = source.length;

  if (allowShebang && source.startsWith("#!")) {
    const end = findLineEnd(source, 0);
    comments.push(
      makeRawComment(source, lineStarts, {
        start: 0,
        end,
        kind: "line",
        prefix: "#!",
        language: "shell",
        isLineComment: true,
      }),
    );
    i = end;
    if (i < len && source.charCodeAt(i) === 10) i++;
  }

  function consumePendingHeredocs(): void {
    while (pendingHeredocs.length > 0 && i < len) {
      const heredoc = pendingHeredocs.shift()!;
      while (i < len) {
        const lineEnd = findLineEnd(source, i);
        let rawLine = source.slice(i, lineEnd);
        if (rawLine.endsWith("\r")) {
          rawLine = rawLine.slice(0, -1);
        }
        const candidate = heredoc.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
        i = lineEnd < len ? lineEnd + 1 : len;
        if (candidate === heredoc.delimiter) {
          break;
        }
      }
    }
  }

  function scanSingleQuoted(): void {
    i++;
    while (i < len) {
      if (source.charCodeAt(i) === 39) {
        i++;
        return;
      }
      i++;
    }
  }

  function scanAnsiCQuoted(): void {
    i += 2;
    while (i < len) {
      const c = source.charCodeAt(i);
      if (c === 92) {
        i = Math.min(i + 2, len);
        continue;
      }
      i++;
      if (c === 39) return;
    }
  }

  function scanBacktick(): void {
    i++;
    while (i < len) {
      const c = source.charCodeAt(i);
      if (c === 92) {
        i = Math.min(i + 2, len);
        continue;
      }
      i++;
      if (c === 96) return;
    }
  }

  function scanArithmetic(): void {
    i += 3;
    let depth = 2;
    while (i < len && depth > 0) {
      const c = source.charCodeAt(i);
      if (c === 92) {
        i = Math.min(i + 2, len);
        continue;
      }
      if (c === 34) {
        scanDoubleQuoted();
        continue;
      }
      if (c === 39) {
        scanSingleQuoted();
        continue;
      }
      if (c === 40) {
        depth++;
      } else if (c === 41) {
        depth--;
      }
      i++;
    }
  }

  function scanParamExpansion(): void {
    i += 2;
    let depth = 1;
    while (i < len && depth > 0) {
      const c = source.charCodeAt(i);
      if (c === 92) {
        i = Math.min(i + 2, len);
        continue;
      }
      if (c === 39) {
        scanSingleQuoted();
        continue;
      }
      if (c === 34) {
        scanDoubleQuoted();
        continue;
      }
      if (c === 36 && source.charCodeAt(i + 1) === 40) {
        if (source.charCodeAt(i + 2) === 40) {
          scanArithmetic();
        } else {
          scanCommandSubstitution();
        }
        continue;
      }
      if (c === 123) {
        depth++;
      } else if (c === 125) {
        depth--;
      }
      i++;
    }
  }

  function scanDoubleQuoted(): void {
    i++;
    while (i < len) {
      const c = source.charCodeAt(i);
      if (c === 92) {
        i = Math.min(i + 2, len);
        continue;
      }
      if (c === 34) {
        i++;
        return;
      }
      if (c === 36) {
        const next = source.charCodeAt(i + 1);
        if (next === 123) {
          scanParamExpansion();
          continue;
        }
        if (next === 40) {
          if (source.charCodeAt(i + 2) === 40) {
            scanArithmetic();
          } else {
            scanCommandSubstitution();
          }
          continue;
        }
      }
      if (c === 96) {
        scanBacktick();
        continue;
      }
      i++;
    }
  }

  function scanHeredocHeader(): void {
    i += 2;
    let stripTabs = false;
    if (source.charCodeAt(i) === 45) {
      stripTabs = true;
      i++;
    }
    while (i < len && (source.charCodeAt(i) === 32 || source.charCodeAt(i) === 9)) {
      i++;
    }
    let delimiter = "";
    while (i < len) {
      const c = source.charCodeAt(i);
      if (
        c === 32 ||
        c === 9 ||
        c === 10 ||
        c === 13 ||
        c === 59 ||
        c === 124 ||
        c === 38 ||
        c === 40 ||
        c === 41 ||
        c === 60 ||
        c === 62
      ) {
        break;
      }
      if (c === 39) {
        i++;
        while (i < len && source.charCodeAt(i) !== 39) {
          delimiter += source[i];
          i++;
        }
        if (i < len) i++;
        continue;
      }
      if (c === 34) {
        i++;
        while (i < len && source.charCodeAt(i) !== 34) {
          if (source.charCodeAt(i) === 92 && i + 1 < len) {
            i++;
          }
          delimiter += source[i];
          i++;
        }
        if (i < len) i++;
        continue;
      }
      if (c === 92 && i + 1 < len) {
        i++;
        delimiter += source[i];
        i++;
        continue;
      }
      delimiter += source[i];
      i++;
    }
    if (delimiter.length > 0) {
      pendingHeredocs.push({ delimiter, stripTabs });
    }
  }

  function scanCommandSubstitution(): void {
    i += 2;
    scanCode(true);
  }

  function scanCode(stopOnCloseParen: boolean): void {
    let atWordStart = true;
    let parenDepth = stopOnCloseParen ? 1 : 0;

    while (i < len) {
      const ch = source.charCodeAt(i);

      if (ch === 10) {
        i++;
        atWordStart = true;
        if (pendingHeredocs.length > 0) {
          consumePendingHeredocs();
        }
        continue;
      }

      if (ch === 32 || ch === 9 || ch === 13) {
        i++;
        atWordStart = true;
        continue;
      }

      if (ch === 35 && atWordStart) {
        const start = i;
        const end = findLineEnd(source, i + 1);
        comments.push(
          makeRawComment(source, lineStarts, {
            start,
            end,
            kind: "line",
            prefix: "#",
            language: "shell",
            isLineComment: true,
          }),
        );
        i = end;
        continue;
      }

      if (ch === 92) {
        if (source.charCodeAt(i + 1) === 10) {
          i += 2;
        } else if (source.charCodeAt(i + 1) === 13 && source.charCodeAt(i + 2) === 10) {
          i += 3;
        } else {
          i = Math.min(i + 2, len);
          atWordStart = false;
        }
        continue;
      }

      if (ch === 39) {
        scanSingleQuoted();
        atWordStart = false;
        continue;
      }

      if (ch === 34) {
        scanDoubleQuoted();
        atWordStart = false;
        continue;
      }

      if (ch === 96) {
        scanBacktick();
        atWordStart = false;
        continue;
      }

      if (ch === 36) {
        const next = source.charCodeAt(i + 1);
        if (next === 39) {
          scanAnsiCQuoted();
          atWordStart = false;
          continue;
        }
        if (next === 123) {
          scanParamExpansion();
          atWordStart = false;
          continue;
        }
        if (next === 40) {
          if (source.charCodeAt(i + 2) === 40) {
            scanArithmetic();
          } else {
            scanCommandSubstitution();
          }
          atWordStart = false;
          continue;
        }
        i = Math.min(i + 2, len);
        atWordStart = false;
        continue;
      }

      if (ch === 60 && source.charCodeAt(i + 1) === 60) {
        if (source.charCodeAt(i + 2) === 60) {
          i += 3;
          atWordStart = false;
        } else {
          scanHeredocHeader();
          atWordStart = false;
        }
        continue;
      }

      if (ch === 40) {
        if (stopOnCloseParen) parenDepth++;
        i++;
        atWordStart = true;
        continue;
      }

      if (ch === 41) {
        i++;
        if (stopOnCloseParen) {
          parenDepth--;
          if (parenDepth === 0) return;
        }
        atWordStart = true;
        continue;
      }

      if (ch === 59 || ch === 124 || ch === 38) {
        i++;
        atWordStart = true;
        continue;
      }

      i++;
      atWordStart = false;
    }
  }

  scanCode(false);
  return comments;
}

function countLeadingSpaces(text: string): number {
  let count = 0;
  while (count < text.length && text.charCodeAt(count) === 32) {
    count++;
  }
  return count;
}

interface YamlBlockHeader {
  keyName: string | null;
  parentIndent: number;
  explicitIndent: number | null;
}

function parseYamlBlockScalarHeader(codeLine: string): YamlBlockHeader | null {
  const trimmedEnd = codeLine.trimEnd();
  if (trimmedEnd.length === 0) return null;

  const indicatorMatch = /(?:^|[ \t])([|>](?:[+-][1-9]?|[1-9][+-]?)?)$/.exec(trimmedEnd);
  if (!indicatorMatch) return null;

  const indicator = indicatorMatch[1];
  const beforeIndicator = trimmedEnd.slice(0, trimmedEnd.length - indicator.length).trimEnd();
  const parentIndent = countLeadingSpaces(codeLine);

  const digitMatch = /[1-9]/.exec(indicator);
  const explicitIndent = digitMatch ? Number(digitMatch[0]) : null;

  if (beforeIndicator.endsWith(":")) {
    let keyPart = beforeIndicator.slice(0, -1).trim();
    while (keyPart.startsWith("- ") || keyPart.startsWith("-\t")) {
      keyPart = keyPart.slice(2).trimStart();
    }
    if ((keyPart.startsWith('"') && keyPart.endsWith('"')) || (keyPart.startsWith("'") && keyPart.endsWith("'"))) {
      keyPart = keyPart.slice(1, -1);
    }
    return { keyName: keyPart, parentIndent, explicitIndent };
  }

  if (/^[ \t]*(?:-[ \t]+)*-$/.test(beforeIndicator)) {
    return { keyName: null, parentIndent, explicitIndent };
  }

  return null;
}

function canStartYamlQuotedScalar(line: string, pos: number): boolean {
  if (pos === 0) return true;
  const prev = line.charCodeAt(pos - 1);
  return prev === 32 || prev === 9 || prev === 91 || prev === 123 || prev === 44 || prev === 58;
}

function lexYamlComments(source: string): RawComment[] {
  const lineStarts = buildLineIndex(source);
  const comments: RawComment[] = [];
  const totalLines = lineStarts.length;
  let quoteMode: null | "'" | '"' = null;

  for (let lineIdx = 0; lineIdx < totalLines; lineIdx++) {
    const bounds = lineBounds(source, lineStarts, lineIdx + 1);
    const line = source.slice(bounds.start, bounds.end);
    let pos = 0;
    let commentStartInLine = -1;

    while (pos < line.length) {
      const ch = line.charCodeAt(pos);
      if (quoteMode === "'") {
        if (ch === 39) {
          if (line.charCodeAt(pos + 1) === 39) {
            pos += 2;
            continue;
          }
          quoteMode = null;
        }
        pos++;
        continue;
      }

      if (quoteMode === '"') {
        if (ch === 92) {
          pos += 2;
          continue;
        }
        if (ch === 34) {
          quoteMode = null;
        }
        pos++;
        continue;
      }

      if (ch === 35) {
        if (pos === 0 || line.charCodeAt(pos - 1) === 32 || line.charCodeAt(pos - 1) === 9) {
          commentStartInLine = pos;
          break;
        }
        pos++;
        continue;
      }

      if (ch === 39 && canStartYamlQuotedScalar(line, pos)) {
        quoteMode = "'";
        pos++;
        continue;
      }

      if (ch === 34 && canStartYamlQuotedScalar(line, pos)) {
        quoteMode = '"';
        pos++;
        continue;
      }

      pos++;
    }

    if (commentStartInLine !== -1) {
      comments.push(
        makeRawComment(source, lineStarts, {
          start: bounds.start + commentStartInLine,
          end: bounds.end,
          kind: "line",
          prefix: "#",
          language: "yaml",
          isLineComment: true,
        }),
      );
    }

    if (quoteMode !== null) {
      continue;
    }

    const codeLine = commentStartInLine === -1 ? line : line.slice(0, commentStartInLine);
    const blockHeader = parseYamlBlockScalarHeader(codeLine);
    if (!blockHeader) {
      continue;
    }

    let blockIndent = blockHeader.explicitIndent !== null ? blockHeader.parentIndent + blockHeader.explicitIndent : -1;
    const blockLineIndices: number[] = [];
    let nextIdx = lineIdx + 1;

    while (nextIdx < totalLines) {
      const nextBounds = lineBounds(source, lineStarts, nextIdx + 1);
      const nextLine = source.slice(nextBounds.start, nextBounds.end);
      const isBlank = nextLine.trim().length === 0;
      const indent = countLeadingSpaces(nextLine);

      if (blockIndent === -1) {
        if (isBlank) {
          blockLineIndices.push(nextIdx);
          nextIdx++;
          continue;
        }
        if (indent <= blockHeader.parentIndent) {
          break;
        }
        blockIndent = indent;
        blockLineIndices.push(nextIdx);
        nextIdx++;
        continue;
      }

      if (isBlank || indent >= blockIndent) {
        blockLineIndices.push(nextIdx);
        nextIdx++;
        continue;
      }
      break;
    }

    if (blockIndent !== -1 && blockHeader.keyName === "run" && blockLineIndices.length > 0) {
      const virtualLines: string[] = [];
      const origLineOffsets: number[] = [];
      for (const idx of blockLineIndices) {
        const b = lineBounds(source, lineStarts, idx + 1);
        const origLine = source.slice(b.start, b.end);
        const strip = Math.min(blockIndent, countLeadingSpaces(origLine));
        virtualLines.push(origLine.slice(strip));
        origLineOffsets.push(b.start + strip);
      }
      const virtualSource = virtualLines.join("\n");
      const virtualLineStarts = buildLineIndex(virtualSource);
      const shellComments = lexShellComments(virtualSource, false);
      for (const sc of shellComments) {
        const vStart = offsetToLineCol(virtualLineStarts, sc.start);
        const vEnd = offsetToLineCol(virtualLineStarts, sc.end);
        const origStart = origLineOffsets[vStart.line - 1] + vStart.col;
        const origEnd = origLineOffsets[vEnd.line - 1] + vEnd.col;
        comments.push(
          makeRawComment(source, lineStarts, {
            start: origStart,
            end: origEnd,
            kind: "line",
            prefix: "#",
            language: "shell",
            isLineComment: true,
          }),
        );
      }
    }

    lineIdx = nextIdx - 1;
  }

  return comments;
}

function lexTomlComments(source: string): RawComment[] {
  const lineStarts = buildLineIndex(source);
  const comments: RawComment[] = [];
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source.charCodeAt(i);

    if (ch === 35) {
      const start = i;
      const end = findLineEnd(source, i + 1);
      comments.push(
        makeRawComment(source, lineStarts, {
          start,
          end,
          kind: "line",
          prefix: "#",
          language: "toml",
          isLineComment: true,
        }),
      );
      i = end;
      continue;
    }

    if (ch === 34) {
      if (source.startsWith('"""', i)) {
        i += 3;
        while (i < len) {
          if (source.charCodeAt(i) === 92) {
            i = Math.min(i + 2, len);
            continue;
          }
          if (source.startsWith('"""', i)) {
            let extra = 0;
            while (extra < 2 && source.charCodeAt(i + 3 + extra) === 34) {
              extra++;
            }
            i += 3 + extra;
            break;
          }
          i++;
        }
        continue;
      }
      i++;
      while (i < len) {
        const c = source.charCodeAt(i);
        if (c === 92) {
          i = Math.min(i + 2, len);
          continue;
        }
        i++;
        if (c === 34 || c === 10) break;
      }
      continue;
    }

    if (ch === 39) {
      if (source.startsWith("'''", i)) {
        i += 3;
        while (i < len) {
          if (source.startsWith("'''", i)) {
            let extra = 0;
            while (extra < 2 && source.charCodeAt(i + 3 + extra) === 39) {
              extra++;
            }
            i += 3 + extra;
            break;
          }
          i++;
        }
        continue;
      }
      i++;
      while (i < len) {
        const c = source.charCodeAt(i);
        i++;
        if (c === 39 || c === 10) break;
      }
      continue;
    }

    i++;
  }

  return comments;
}

function lexJsoncComments(source: string): RawComment[] {
  const lineStarts = buildLineIndex(source);
  const comments: RawComment[] = [];
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source.charCodeAt(i);

    if (ch === 34) {
      i++;
      while (i < len) {
        const c = source.charCodeAt(i);
        if (c === 92) {
          i = Math.min(i + 2, len);
          continue;
        }
        i++;
        if (c === 34 || c === 10) break;
      }
      continue;
    }

    if (ch === 47 && source.charCodeAt(i + 1) === 47) {
      const start = i;
      const end = findLineEnd(source, i + 2);
      comments.push(
        makeRawComment(source, lineStarts, {
          start,
          end,
          kind: "line",
          prefix: "//",
          language: "jsonc",
          isLineComment: true,
        }),
      );
      i = end;
      continue;
    }

    if (ch === 47 && source.charCodeAt(i + 1) === 42) {
      const start = i;
      const end = scanSimpleBlockComment(source, start);
      comments.push(
        makeRawComment(source, lineStarts, {
          start,
          end,
          kind: "block",
          prefix: "/*",
          language: "jsonc",
          isLineComment: false,
        }),
      );
      i = end;
      continue;
    }

    i++;
  }

  return comments;
}

function stripQuotesForHeredocCheck(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line.charCodeAt(i);
    if (ch === 34 || ch === 39) {
      const quote = ch;
      out += " ";
      i++;
      while (i < line.length && line.charCodeAt(i) !== quote) {
        if (quote === 34 && line.charCodeAt(i) === 92) i++;
        i++;
      }
      if (i < line.length) i++;
      continue;
    }
    out += line[i];
    i++;
  }
  return out;
}

function extractDockerfileHeredocs(line: string): PendingHeredoc[] {
  const results: PendingHeredoc[] = [];
  const cleaned = stripQuotesForHeredocCheck(line);
  const regex = /(?<!<)<<(-?)(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned)) !== null) {
    const delimiter = match[2] ?? match[3] ?? match[4];
    if (delimiter) {
      results.push({ delimiter, stripTabs: match[1] === "-" });
    }
  }
  return results;
}

function lexDockerfileComments(source: string): RawComment[] {
  const lineStarts = buildLineIndex(source);
  const comments: RawComment[] = [];
  const totalLines = lineStarts.length;
  let escapeChar = "\\";
  let seenInstruction = false;
  let inContinuation = false;
  const pendingHeredocs: PendingHeredoc[] = [];

  for (let lineIdx = 0; lineIdx < totalLines; lineIdx++) {
    const bounds = lineBounds(source, lineStarts, lineIdx + 1);
    const line = source.slice(bounds.start, bounds.end);

    if (pendingHeredocs.length > 0 && !inContinuation) {
      const current = pendingHeredocs[0];
      const candidate = current.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === current.delimiter) {
        pendingHeredocs.shift();
      }
      continue;
    }

    const trimmedStart = line.trimStart();
    if (trimmedStart.startsWith("#")) {
      const hashOffset = line.length - trimmedStart.length;
      if (!seenInstruction) {
        const directiveMatch = /^#\s*escape\s*=\s*([\\`])\s*$/i.exec(trimmedStart);
        if (directiveMatch) {
          escapeChar = directiveMatch[1];
        }
      }
      comments.push(
        makeRawComment(source, lineStarts, {
          start: bounds.start + hashOffset,
          end: bounds.end,
          kind: "line",
          prefix: "#",
          language: "dockerfile",
          isLineComment: true,
        }),
      );
      continue;
    }

    if (trimmedStart.length === 0) {
      if (!inContinuation) {
        seenInstruction = true;
      }
      continue;
    }

    seenInstruction = true;
    if (!inContinuation && /^(?:RUN|COPY)\s+/i.test(trimmedStart)) {
      pendingHeredocs.push(...extractDockerfileHeredocs(line));
    }
    const trimmedEnd = line.trimEnd();
    inContinuation = trimmedEnd.endsWith(escapeChar);
  }

  return comments;
}

function endsWithOddBackslashes(line: string): boolean {
  let count = 0;
  for (let i = line.length - 1; i >= 0 && line.charCodeAt(i) === 92; i--) {
    count++;
  }
  return count % 2 === 1;
}

function lexHashLineConfigComments(source: string, language: "proguard" | "properties"): RawComment[] {
  const lineStarts = buildLineIndex(source);
  const comments: RawComment[] = [];
  let inContinuation = false;

  for (let lineIdx = 0; lineIdx < lineStarts.length; lineIdx++) {
    const bounds = lineBounds(source, lineStarts, lineIdx + 1);
    const line = source.slice(bounds.start, bounds.end);

    if (inContinuation) {
      inContinuation = endsWithOddBackslashes(line);
      continue;
    }

    let firstNonSpace = 0;
    while (firstNonSpace < line.length) {
      const c = line.charCodeAt(firstNonSpace);
      if (c !== 32 && c !== 9 && c !== 12) break;
      firstNonSpace++;
    }

    if (firstNonSpace >= line.length) {
      continue;
    }

    const firstChar = line[firstNonSpace];
    if (firstChar === "#" || (language === "properties" && firstChar === "!")) {
      comments.push(
        makeRawComment(source, lineStarts, {
          start: bounds.start + firstNonSpace,
          end: bounds.end,
          kind: "line",
          prefix: firstChar,
          language,
          isLineComment: true,
        }),
      );
      continue;
    }

    inContinuation = endsWithOddBackslashes(line);
  }

  return comments;
}

export function lexComments(source: string, language: Language): RawComment[] {
  switch (language) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return lexTypeScriptComments(source, language);
    case "swift":
      return lexSwiftComments(source);
    case "kotlin":
      return lexKotlinComments(source);
    case "rust":
      return lexRustComments(source);
    case "css":
      return lexCssComments(source);
    case "html":
      return lexHtmlComments(source);
    case "xml":
      return lexXmlComments(source);
    case "shell":
      return lexShellComments(source, true);
    case "yaml":
      return lexYamlComments(source);
    case "toml":
      return lexTomlComments(source);
    case "jsonc":
      return lexJsoncComments(source);
    case "dockerfile":
      return lexDockerfileComments(source);
    case "proguard":
    case "properties":
      return lexHashLineConfigComments(source, language);
  }
}
