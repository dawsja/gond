import { isAbsolute, join, resolve } from "node:path";
import {
  buildBaselineFromResults,
  canonicalizeBaseline,
  compareAgainstBaseline,
  mergeBaselineForScope,
  readBaseline,
  serializeBaseline,
  writeBaseline,
  type BaselineDiff,
  type StaleBaselineEntry,
} from "./comments/baseline.ts";
import {
  createScopeMatcher,
  detectLanguage,
  discoverFiles,
  hasGeneratedFileHeader,
  isExcludedPath,
  type DiscoveredFile,
} from "./comments/discover.ts";
import {
  classifyAndGroupComments,
  computeCommentHash,
  makeCommentPreview,
  normalizeCommentTokens,
  rustSourceRequiresMissingDocs,
  stripTokenDelimiters,
  type GroupedComment,
} from "./comments/exempt.ts";
import { lexComments, lexShellComments } from "./comments/lexers.ts";
import {
  countPhysicalLinesSaved,
  formatTextReport,
  scanRepository,
  scanSource,
} from "./comments/metrics.ts";
import type {
  BaselineEntry,
  BaselineFile,
  CommentItem,
  CommentKind,
  ExemptReason,
  FileScanResult,
  Language,
  RawComment,
  ReportCommentEntry,
  ReportFileEntry,
  ScanReport,
  TextSpan,
} from "./comments/types.ts";

export {
  buildBaselineFromResults,
  canonicalizeBaseline,
  classifyAndGroupComments,
  compareAgainstBaseline,
  computeCommentHash,
  countPhysicalLinesSaved,
  createScopeMatcher,
  detectLanguage,
  discoverFiles,
  formatTextReport,
  hasGeneratedFileHeader,
  isExcludedPath,
  lexComments,
  lexShellComments,
  makeCommentPreview,
  mergeBaselineForScope,
  normalizeCommentTokens,
  readBaseline,
  rustSourceRequiresMissingDocs,
  scanRepository,
  scanSource,
  serializeBaseline,
  stripTokenDelimiters,
  writeBaseline,
};

export type {
  BaselineDiff,
  BaselineEntry,
  BaselineFile,
  CommentItem,
  CommentKind,
  DiscoveredFile,
  ExemptReason,
  FileScanResult,
  GroupedComment,
  Language,
  RawComment,
  ReportCommentEntry,
  ReportFileEntry,
  ScanReport,
  StaleBaselineEntry,
  TextSpan,
};

export const repoRoot = join(import.meta.dir, "..");
export const defaultBaselineFilename = "scripts/comment-baseline.json";

export type CliMode = "check" | "update" | "write-baseline" | "report" | "report-json";

export interface ParsedCliArgs {
  mode: CliMode;
  root: string;
  baselinePath: string;
  paths: string[];
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export function parseCliArgs(argv: string[], defaultRoot = repoRoot): ParsedCliArgs {
  let mode: CliMode | null = null;
  let root = defaultRoot;
  let baselineArg: string | null = null;
  const paths: string[] = [];
  let positionalOnly = false;

  function setMode(next: CliMode): void {
    if (mode !== null && mode !== next) {
      throw new Error(`Conflicting flags: cannot combine --${mode} with --${next}`);
    }
    mode = next;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (positionalOnly) {
      paths.push(arg);
      continue;
    }
    if (arg === "--") {
      positionalOnly = true;
      continue;
    }
    if (arg === "--update") {
      setMode("update");
      continue;
    }
    if (arg === "--write-baseline") {
      setMode("write-baseline");
      continue;
    }
    if (arg === "--report") {
      setMode("report");
      continue;
    }
    if (arg === "--report-json") {
      setMode("report-json");
      continue;
    }
    if (arg === "--root") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --root");
      root = resolve(value);
      continue;
    }
    if (arg.startsWith("--root=")) {
      root = resolve(arg.slice("--root=".length));
      continue;
    }
    if (arg === "--baseline") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --baseline");
      baselineArg = value;
      continue;
    }
    if (arg.startsWith("--baseline=")) {
      baselineArg = arg.slice("--baseline=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    paths.push(arg);
  }

  const resolvedRoot = resolve(root);
  const baselinePath = baselineArg
    ? isAbsolute(baselineArg)
      ? resolve(baselineArg)
      : resolve(resolvedRoot, baselineArg)
    : join(resolvedRoot, defaultBaselineFilename);

  return {
    mode: mode ?? "check",
    root: resolvedRoot,
    baselinePath,
    paths,
  };
}

function formatUnbaselinedLine(comment: CommentItem): string {
  return `${comment.file}:${comment.startLine}: new non-exempt comment [${comment.hash}]: ${comment.preview}`;
}

function formatStaleLine(stale: StaleBaselineEntry): string {
  return `${stale.file}: stale baseline entry [${stale.entry.hash}]: ${stale.entry.preview} - run \`bun run lint:comments -- --update\` to shrink the baseline`;
}

export async function runCli(
  argv: string[],
  io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 1;
  }

  const { results, report } = await scanRepository(parsed.root, parsed.paths);

  if (parsed.mode === "report-json") {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  if (parsed.mode === "report") {
    io.stdout(formatTextReport(report));
    return 0;
  }

  const inScope = createScopeMatcher(parsed.root, parsed.paths);

  if (parsed.mode === "write-baseline") {
    const nextBaseline =
      parsed.paths.length === 0
        ? buildBaselineFromResults(results)
        : mergeBaselineForScope((await readBaseline(parsed.baselinePath)).baseline, results, inScope);
    await writeBaseline(parsed.baselinePath, nextBaseline);
    const totalEntries = Object.values(nextBaseline.files).reduce((sum, list) => sum + list.length, 0);
    const fileCount = Object.keys(nextBaseline.files).length;
    io.stdout(`Wrote baseline (${totalEntries} comment(s) across ${fileCount} file(s)) to ${parsed.baselinePath}\n`);
    return 0;
  }

  const { exists, baseline } = await readBaseline(parsed.baselinePath);
  const diff = compareAgainstBaseline(results, baseline, inScope);

  if (parsed.mode === "update") {
    if (diff.unbaselined.length > 0) {
      for (const item of diff.unbaselined) {
        io.stderr(`${formatUnbaselinedLine(item)}\n`);
      }
      io.stderr(
        `comment-lint --update refused: ${diff.unbaselined.length} new non-exempt comment(s) cannot be added to the baseline.\n`,
      );
      return 1;
    }

    if (!exists || diff.stale.length > 0) {
      await writeBaseline(parsed.baselinePath, diff.shrunkBaseline);
      io.stdout(`Updated baseline: removed ${diff.stale.length} stale entry(ies).\n`);
    } else {
      io.stdout("Baseline is already up to date.\n");
    }
    return 0;
  }

  if (diff.unbaselined.length === 0 && diff.stale.length === 0) {
    return 0;
  }

  if (!exists && diff.unbaselined.length > 0) {
    io.stderr(`Baseline file not found at ${parsed.baselinePath}.\n`);
  }
  for (const item of diff.unbaselined) {
    io.stderr(`${formatUnbaselinedLine(item)}\n`);
  }
  for (const item of diff.stale) {
    io.stderr(`${formatStaleLine(item)}\n`);
  }
  io.stderr(
    `comment-lint failed: ${diff.unbaselined.length} new non-exempt comment(s), ${diff.stale.length} stale baseline entry(ies).\n`,
  );
  return 1;
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
