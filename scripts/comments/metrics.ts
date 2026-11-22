import { readFile } from "node:fs/promises";
import { discoverFiles, hasGeneratedFileHeader } from "./discover.ts";
import { classifyAndGroupComments, createRustMissingDocsChecker } from "./exempt.ts";
import { lexComments } from "./lexers.ts";
import {
  buildLineIndex,
  isWhitespaceOnly,
  lineBounds,
  offsetToLineCol,
  type CommentItem,
  type ExemptReason,
  type FileScanResult,
  type Language,
  type ReportCommentEntry,
  type ReportFileEntry,
  type ScanReport,
  type TextSpan,
} from "./types.ts";

function mergeSpans(spans: TextSpan[]): TextSpan[] {
  if (spans.length === 0) return [];
  const sorted = spans
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (sorted.length === 0) return [];
  const merged: TextSpan[] = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.start <= prev.end) {
      if (curr.end > prev.end) {
        prev.end = curr.end;
      }
    } else {
      merged.push({ start: curr.start, end: curr.end });
    }
  }
  return merged;
}

export function countPhysicalLinesSaved(
  source: string,
  comments: ReadonlyArray<Pick<CommentItem, "spans">>,
): number {
  if (source.length === 0 || comments.length === 0) return 0;
  const allSpans: TextSpan[] = [];
  for (const comment of comments) {
    for (const span of comment.spans) {
      allSpans.push(span);
    }
  }
  const merged = mergeSpans(allSpans);
  if (merged.length === 0) return 0;

  const lineStarts = buildLineIndex(source);
  const spansByLine = new Map<number, TextSpan[]>();

  for (const span of merged) {
    const firstLine = offsetToLineCol(lineStarts, span.start).line;
    const lastLine = offsetToLineCol(lineStarts, Math.max(span.start, span.end - 1)).line;
    for (let lineNum = firstLine; lineNum <= lastLine; lineNum++) {
      let list = spansByLine.get(lineNum);
      if (!list) {
        list = [];
        spansByLine.set(lineNum, list);
      }
      list.push(span);
    }
  }

  let saved = 0;
  for (const [lineNum, lineSpans] of spansByLine) {
    const bounds = lineBounds(source, lineStarts, lineNum);
    const lineHasContent = bounds.end > bounds.start;
    let whollyInsideSpan = false;
    let cursor = bounds.start;
    let remainingIsEmpty = true;

    for (const span of lineSpans) {
      if (span.start <= bounds.start && span.end > bounds.end) {
        whollyInsideSpan = true;
      }
      const clipStart = Math.max(bounds.start, span.start);
      const clipEnd = Math.min(bounds.end, span.end);
      if (clipStart > cursor) {
        if (!isWhitespaceOnly(source.slice(cursor, clipStart))) {
          remainingIsEmpty = false;
          break;
        }
      }
      if (clipEnd > cursor) {
        cursor = clipEnd;
      }
    }

    if (remainingIsEmpty && cursor < bounds.end) {
      if (!isWhitespaceOnly(source.slice(cursor, bounds.end))) {
        remainingIsEmpty = false;
      }
    }

    if (remainingIsEmpty && (lineHasContent || whollyInsideSpan)) {
      saved++;
    }
  }

  return saved;
}

export function scanSource(
  file: string,
  source: string,
  language: Language,
  options?: { rustRequiresMissingDocs?: boolean },
): FileScanResult {
  const rawTokens = lexComments(source, language);
  if (hasGeneratedFileHeader(rawTokens)) {
    return {
      file,
      language,
      excludedAsGenerated: true,
      comments: [],
      exemptComments: [],
      nonExemptComments: [],
      estimatedLinesSaved: 0,
    };
  }

  const grouped = classifyAndGroupComments(
    source,
    language,
    rawTokens,
    options?.rustRequiresMissingDocs ?? false,
  );

  const comments: CommentItem[] = grouped.map((group) => ({
    file,
    language: group.language,
    kind: group.kind,
    prefix: group.prefix,
    start: group.start,
    end: group.end,
    removalStart: group.removalStart,
    removalEnd: group.removalEnd,
    startLine: group.startLine,
    endLine: group.endLine,
    inline: group.inline,
    text: group.text,
    normalizedText: group.normalizedText,
    hash: group.hash,
    preview: group.preview,
    exempt: group.exempt,
    physicalLinesSaved: countPhysicalLinesSaved(source, [group]),
    spans: group.spans,
  }));

  const exemptComments = comments.filter((comment) => comment.exempt !== null);
  const nonExemptComments = comments.filter((comment) => comment.exempt === null);
  const estimatedLinesSaved = countPhysicalLinesSaved(source, nonExemptComments);

  return {
    file,
    language,
    excludedAsGenerated: false,
    comments,
    exemptComments,
    nonExemptComments,
    estimatedLinesSaved,
  };
}

export async function scanRepository(
  root: string,
  targetPaths: string[] = [],
): Promise<{ results: FileScanResult[]; report: ScanReport }> {
  const discovered = await discoverFiles(root, targetPaths);
  const rustChecker = createRustMissingDocsChecker(root);
  const results: FileScanResult[] = [];
  const filesSkippedGenerated: string[] = [];

  for (const file of discovered) {
    const source = await readFile(file.absPath, "utf8");
    const rustRequiresMissingDocs =
      file.language === "rust" ? await rustChecker(file.absPath, source) : false;
    const result = scanSource(file.relPath, source, file.language, { rustRequiresMissingDocs });
    if (result.excludedAsGenerated) {
      filesSkippedGenerated.push(file.relPath);
      continue;
    }
    results.push(result);
  }

  const exemptByReason: Record<ExemptReason, number> = {
    license: 0,
    directive: 0,
    "api-doc": 0,
  };
  let totalComments = 0;
  let exemptCount = 0;
  let nonExemptCount = 0;
  let estimatedTotalLinesSaved = 0;
  const reportComments: ReportCommentEntry[] = [];
  const reportFiles: ReportFileEntry[] = [];

  for (const result of results) {
    totalComments += result.comments.length;
    exemptCount += result.exemptComments.length;
    nonExemptCount += result.nonExemptComments.length;
    estimatedTotalLinesSaved += result.estimatedLinesSaved;

    for (const comment of result.exemptComments) {
      if (comment.exempt) {
        exemptByReason[comment.exempt]++;
      }
    }

    for (const comment of result.nonExemptComments) {
      reportComments.push({
        file: comment.file,
        language: comment.language,
        kind: comment.kind,
        startLine: comment.startLine,
        endLine: comment.endLine,
        inline: comment.inline,
        physicalLinesSaved: comment.physicalLinesSaved,
        hash: comment.hash,
        preview: comment.preview,
        text: comment.text,
      });
    }

    reportFiles.push({
      file: result.file,
      language: result.language,
      nonExemptCount: result.nonExemptComments.length,
      exemptCount: result.exemptComments.length,
      estimatedLinesSaved: result.estimatedLinesSaved,
    });
  }

  const report: ScanReport = {
    filesScanned: results.length,
    filesSkippedGenerated,
    totalComments,
    exemptCount,
    exemptByReason,
    nonExemptCount,
    estimatedTotalLinesSaved,
    comments: reportComments,
    files: reportFiles,
  };

  return { results, report };
}

export function formatTextReport(report: ScanReport): string {
  const lines: string[] = [
    `Files scanned: ${report.filesScanned}`,
    `Generated files skipped: ${report.filesSkippedGenerated.length}`,
    `Total logical comments: ${report.totalComments}`,
    `Exempt comments: ${report.exemptCount} (license: ${report.exemptByReason.license}, directive: ${report.exemptByReason.directive}, api-doc: ${report.exemptByReason["api-doc"]})`,
    `Non-exempt comments: ${report.nonExemptCount}`,
    `Estimated physical lines saved if all non-exempt removed: ${report.estimatedTotalLinesSaved}`,
  ];

  const topFiles = report.files
    .filter((entry) => entry.nonExemptCount > 0)
    .sort((a, b) => b.nonExemptCount - a.nonExemptCount || b.estimatedLinesSaved - a.estimatedLinesSaved)
    .slice(0, 20);

  if (topFiles.length > 0) {
    lines.push("", "Top files by non-exempt comment count:");
    for (const entry of topFiles) {
      lines.push(`  ${entry.file}: ${entry.nonExemptCount} comments (${entry.estimatedLinesSaved} lines)`);
    }
  }

  return `${lines.join("\n")}\n`;
}
