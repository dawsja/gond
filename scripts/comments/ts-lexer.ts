import { createRequire } from "node:module";
import { join } from "node:path";
import type * as TypeScript from "../../packages/shared/node_modules/typescript/lib/typescript.d.ts";
import { buildLineIndex, makeRawComment, type CommentKind, type Language, type RawComment } from "./types.ts";

type TsModule = typeof TypeScript;

let cachedTs: TsModule | null = null;

function loadTypeScript(): TsModule {
  if (cachedTs) return cachedTs;
  const require = createRequire(import.meta.url);
  const repoRoot = join(import.meta.dir, "..", "..");
  const candidates = [
    "typescript",
    join(repoRoot, "packages/shared/node_modules/typescript/lib/typescript.js"),
    join(repoRoot, "apps/api/node_modules/typescript/lib/typescript.js"),
    join(repoRoot, "apps/web/node_modules/typescript/lib/typescript.js"),
  ];
  for (const candidate of candidates) {
    try {
      cachedTs = require(candidate) as TsModule;
      return cachedTs;
    } catch {
      continue;
    }
  }
  throw new Error("Could not resolve TypeScript compiler package");
}

function scriptKindFor(ts: TsModule, language: Language): { fileName: string; scriptKind: TypeScript.ScriptKind } {
  switch (language) {
    case "tsx":
      return { fileName: "source.tsx", scriptKind: ts.ScriptKind.TSX };
    case "js":
      return { fileName: "source.js", scriptKind: ts.ScriptKind.JS };
    case "jsx":
      return { fileName: "source.jsx", scriptKind: ts.ScriptKind.JSX };
    default:
      return { fileName: "source.ts", scriptKind: ts.ScriptKind.TS };
  }
}

interface ScannedTriviaComment {
  start: number;
  end: number;
  syntaxKind: TypeScript.SyntaxKind;
}

export function lexTypeScriptComments(source: string, language: "ts" | "tsx" | "js" | "jsx"): RawComment[] {
  const ts = loadTypeScript();
  const { fileName, scriptKind } = scriptKindFor(ts, language);
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const lineStarts = buildLineIndex(source);
  const seen = new Set<string>();
  const comments: RawComment[] = [];

  function scanTriviaGap(from: number, to: number): ScannedTriviaComment[] {
    if (to <= from) return [];
    const found: ScannedTriviaComment[] = [];
    scanner.setTextPos(from);
    while (scanner.getTextPos() < to) {
      const token = scanner.scan();
      const start = scanner.getTokenPos();
      const end = scanner.getTextPos();
      if (end > to) break;
      if (
        token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia ||
        token === ts.SyntaxKind.ShebangTrivia
      ) {
        const key = `${start}:${end}`;
        if (!seen.has(key)) {
          seen.add(key);
          found.push({ start, end, syntaxKind: token });
        }
      } else if (token === ts.SyntaxKind.EndOfFileToken) {
        break;
      }
    }
    return found;
  }

  function classifyTsComment(text: string, syntaxKind: TypeScript.SyntaxKind): {
    kind: CommentKind;
    prefix: string;
    isLineComment: boolean;
  } {
    if (syntaxKind === ts.SyntaxKind.ShebangTrivia) {
      return { kind: "line", prefix: "#!", isLineComment: true };
    }
    if (syntaxKind === ts.SyntaxKind.SingleLineCommentTrivia) {
      const isTripleSlash = text.startsWith("///") && !text.startsWith("////");
      return { kind: "line", prefix: isTripleSlash ? "///" : "//", isLineComment: true };
    }
    if (text.startsWith("/**") && text !== "/**/") {
      return { kind: "doc", prefix: "/**", isLineComment: false };
    }
    return { kind: "block", prefix: "/*", isLineComment: false };
  }

  function isEmptyJsxCommentContainer(node: TypeScript.Node): TypeScript.JsxExpression | null {
    if (node.kind !== ts.SyntaxKind.CloseBraceToken) return null;
    const parent = node.parent;
    if (!parent || !ts.isJsxExpression(parent)) return null;
    if (parent.expression !== undefined) return null;
    if (parent.parent && ts.isJsxAttribute(parent.parent)) return null;
    return parent;
  }

  function visit(node: TypeScript.Node): void {
    if (node.kind === ts.SyntaxKind.JsxText) return;
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      const tokenStart = node.getStart(sourceFile, false);
      const triviaComments = scanTriviaGap(node.pos, tokenStart);
      if (triviaComments.length === 0) return;

      const emptyJsx = isEmptyJsxCommentContainer(node);
      if (emptyJsx) {
        const containerStart = emptyJsx.getStart(sourceFile, false);
        const containerEnd = emptyJsx.end;
        for (let i = 0; i < triviaComments.length; i++) {
          const item = triviaComments[i];
          const isBlock = item.syntaxKind === ts.SyntaxKind.MultiLineCommentTrivia;
          comments.push(
            makeRawComment(source, lineStarts, {
              start: item.start,
              end: item.end,
              removalStart: i === 0 ? containerStart : item.start,
              removalEnd: i === triviaComments.length - 1 ? containerEnd : item.end,
              kind: "jsx",
              prefix: isBlock ? "{/*" : "//",
              language,
              isLineComment: false,
            }),
          );
        }
        return;
      }

      for (const item of triviaComments) {
        const text = source.slice(item.start, item.end);
        const info = classifyTsComment(text, item.syntaxKind);
        comments.push(
          makeRawComment(source, lineStarts, {
            start: item.start,
            end: item.end,
            kind: info.kind,
            prefix: info.prefix,
            language,
            isLineComment: info.isLineComment,
          }),
        );
      }
      return;
    }

    for (const child of children) {
      visit(child);
    }
  }

  visit(sourceFile);
  comments.sort((a, b) => a.start - b.start);
  return comments;
}
