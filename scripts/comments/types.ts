export type Language =
  | "ts"
  | "tsx"
  | "js"
  | "jsx"
  | "swift"
  | "kotlin"
  | "rust"
  | "css"
  | "html"
  | "xml"
  | "shell"
  | "yaml"
  | "toml"
  | "jsonc"
  | "dockerfile"
  | "proguard"
  | "properties";

export type CommentKind = "line" | "block" | "doc" | "html" | "jsx";

export type ExemptReason = "license" | "directive" | "api-doc";

export interface TextSpan {
  start: number;
  end: number;
}

export interface RawComment {
  start: number;
  end: number;
  removalStart: number;
  removalEnd: number;
  text: string;
  kind: CommentKind;
  prefix: string;
  language: Language;
  startLine: number;
  endLine: number;
  column: number;
  standalone: boolean;
  inline: boolean;
  isLineComment: boolean;
}

export interface CommentItem {
  file: string;
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
  physicalLinesSaved: number;
  spans: TextSpan[];
}

export interface BaselineEntry {
  hash: string;
  preview: string;
}

export interface BaselineFile {
  version: 1;
  files: Record<string, BaselineEntry[]>;
}

export interface FileScanResult {
  file: string;
  language: Language;
  excludedAsGenerated: boolean;
  comments: CommentItem[];
  exemptComments: CommentItem[];
  nonExemptComments: CommentItem[];
  estimatedLinesSaved: number;
}

export interface ReportCommentEntry {
  file: string;
  language: Language;
  kind: CommentKind;
  startLine: number;
  endLine: number;
  inline: boolean;
  physicalLinesSaved: number;
  hash: string;
  preview: string;
  text: string;
}

export interface ReportFileEntry {
  file: string;
  language: Language;
  nonExemptCount: number;
  exemptCount: number;
  estimatedLinesSaved: number;
}

export interface ScanReport {
  filesScanned: number;
  filesSkippedGenerated: string[];
  totalComments: number;
  exemptCount: number;
  exemptByReason: Record<ExemptReason, number>;
  nonExemptCount: number;
  estimatedTotalLinesSaved: number;
  comments: ReportCommentEntry[];
  files: ReportFileEntry[];
}

export function buildLineIndex(source: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

export function offsetToLineCol(lineStarts: number[], offset: number): { line: number; col: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { line: low + 1, col: offset - lineStarts[low] };
}

export function lineBounds(source: string, lineStarts: number[], lineNumber: number): { start: number; end: number } {
  const start = lineStarts[lineNumber - 1];
  const rawEnd = lineNumber < lineStarts.length ? lineStarts[lineNumber] - 1 : source.length;
  const end = rawEnd > start && source.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
  return { start, end };
}

export function isWhitespaceOnly(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 32 && code !== 9 && code !== 13 && code !== 12 && code !== 11 && code !== 0xfeff) {
      return false;
    }
  }
  return true;
}

export function makeRawComment(
  source: string,
  lineStarts: number[],
  params: {
    start: number;
    end: number;
    removalStart?: number;
    removalEnd?: number;
    kind: CommentKind;
    prefix: string;
    language: Language;
    isLineComment: boolean;
  },
): RawComment {
  const start = params.start;
  let end = params.end;
  if (params.isLineComment && end > start && source.charCodeAt(end - 1) === 13) {
    end--;
  }
  const removalStart = params.removalStart ?? start;
  const removalEnd = params.removalEnd ?? end;
  const startPos = offsetToLineCol(lineStarts, start);
  const endOffset = end > start ? end - 1 : start;
  const endPos = offsetToLineCol(lineStarts, endOffset);
  const removalStartPos = offsetToLineCol(lineStarts, removalStart);
  const removalEndOffset = removalEnd > removalStart ? removalEnd - 1 : removalStart;
  const removalEndPos = offsetToLineCol(lineStarts, removalEndOffset);
  const firstBounds = lineBounds(source, lineStarts, removalStartPos.line);
  const lastBounds = lineBounds(source, lineStarts, removalEndPos.line);
  const before = source.slice(firstBounds.start, removalStart);
  const after = source.slice(removalEnd, lastBounds.end);
  const beforeEmpty = isWhitespaceOnly(before);
  const afterEmpty = isWhitespaceOnly(after);

  return {
    start,
    end,
    removalStart,
    removalEnd,
    text: source.slice(start, end),
    kind: params.kind,
    prefix: params.prefix,
    language: params.language,
    startLine: startPos.line,
    endLine: endPos.line,
    column: startPos.col,
    standalone: beforeEmpty && afterEmpty,
    inline: !beforeEmpty || !afterEmpty,
    isLineComment: params.isLineComment,
  };
}
