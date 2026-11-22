import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compareStrings } from "./discover.ts";
import type { BaselineEntry, BaselineFile, CommentItem, FileScanResult } from "./types.ts";

export interface StaleBaselineEntry {
  file: string;
  entry: BaselineEntry;
}

export interface BaselineDiff {
  unbaselined: CommentItem[];
  stale: StaleBaselineEntry[];
  shrunkBaseline: BaselineFile;
}

export function sortBaselineEntries(entries: BaselineEntry[]): BaselineEntry[] {
  return [...entries].sort(
    (a, b) => compareStrings(a.hash, b.hash) || compareStrings(a.preview, b.preview),
  );
}

export function canonicalizeBaseline(baseline: BaselineFile): BaselineFile {
  const files: Record<string, BaselineEntry[]> = {};
  for (const file of Object.keys(baseline.files).sort(compareStrings)) {
    const entries = baseline.files[file];
    if (!entries || entries.length === 0) continue;
    files[file] = sortBaselineEntries(entries).map((entry) => ({
      hash: entry.hash,
      preview: entry.preview,
    }));
  }
  return { version: 1, files };
}

export function serializeBaseline(baseline: BaselineFile): string {
  return `${JSON.stringify(canonicalizeBaseline(baseline), null, 2)}\n`;
}

export function buildBaselineFromResults(results: FileScanResult[]): BaselineFile {
  const files: Record<string, BaselineEntry[]> = {};
  for (const result of results) {
    if (result.excludedAsGenerated || result.nonExemptComments.length === 0) continue;
    files[result.file] = sortBaselineEntries(
      result.nonExemptComments.map((comment) => ({
        hash: comment.hash,
        preview: comment.preview,
      })),
    );
  }
  return canonicalizeBaseline({ version: 1, files });
}

export function mergeBaselineForScope(
  existing: BaselineFile,
  results: FileScanResult[],
  inScope: (relPath: string) => boolean,
): BaselineFile {
  const files: Record<string, BaselineEntry[]> = {};
  for (const [file, entries] of Object.entries(existing.files)) {
    if (!inScope(file) && entries.length > 0) {
      files[file] = sortBaselineEntries(entries);
    }
  }
  for (const result of results) {
    if (result.excludedAsGenerated || result.nonExemptComments.length === 0) continue;
    files[result.file] = sortBaselineEntries(
      result.nonExemptComments.map((comment) => ({
        hash: comment.hash,
        preview: comment.preview,
      })),
    );
  }
  return canonicalizeBaseline({ version: 1, files });
}

export async function readBaseline(baselinePath: string): Promise<{ exists: boolean; baseline: BaselineFile }> {
  try {
    const raw = await readFile(baselinePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<BaselineFile>;
    if (parsed.version !== 1 || typeof parsed.files !== "object" || parsed.files === null) {
      throw new Error(`Invalid comment baseline format in ${baselinePath}`);
    }
    return {
      exists: true,
      baseline: canonicalizeBaseline({
        version: 1,
        files: parsed.files as Record<string, BaselineEntry[]>,
      }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { exists: false, baseline: { version: 1, files: {} } };
    }
    throw error;
  }
}

export async function writeBaseline(baselinePath: string, baseline: BaselineFile): Promise<void> {
  await mkdir(dirname(baselinePath), { recursive: true });
  await writeFile(baselinePath, serializeBaseline(baseline), "utf8");
}

export function compareAgainstBaseline(
  results: FileScanResult[],
  baseline: BaselineFile,
  inScope: (relPath: string) => boolean,
): BaselineDiff {
  const scannedByFile = new Map<string, CommentItem[]>();
  for (const result of results) {
    if (!result.excludedAsGenerated) {
      scannedByFile.set(result.file, result.nonExemptComments);
    }
  }

  const nextFiles: Record<string, BaselineEntry[]> = {};
  const inScopeFiles = new Set<string>();

  for (const [file, entries] of Object.entries(baseline.files)) {
    if (inScope(file)) {
      inScopeFiles.add(file);
    } else if (entries.length > 0) {
      nextFiles[file] = sortBaselineEntries(entries);
    }
  }

  for (const file of scannedByFile.keys()) {
    if (inScope(file)) {
      inScopeFiles.add(file);
    }
  }

  const unbaselined: CommentItem[] = [];
  const stale: StaleBaselineEntry[] = [];

  for (const file of [...inScopeFiles].sort(compareStrings)) {
    const baselineEntries = baseline.files[file] ?? [];
    const currentComments = scannedByFile.get(file) ?? [];
    const buckets = new Map<string, BaselineEntry[]>();

    for (const entry of baselineEntries) {
      let bucket = buckets.get(entry.hash);
      if (!bucket) {
        bucket = [];
        buckets.set(entry.hash, bucket);
      }
      bucket.push(entry);
    }

    const retained: BaselineEntry[] = [];
    for (const comment of currentComments) {
      const bucket = buckets.get(comment.hash);
      if (bucket && bucket.length > 0) {
        retained.push(bucket.shift()!);
      } else {
        unbaselined.push(comment);
      }
    }

    for (const remaining of buckets.values()) {
      for (const entry of remaining) {
        stale.push({ file, entry });
      }
    }

    if (retained.length > 0) {
      nextFiles[file] = sortBaselineEntries(retained);
    }
  }

  unbaselined.sort(
    (a, b) => compareStrings(a.file, b.file) || a.startLine - b.startLine || a.start - b.start,
  );
  stale.sort(
    (a, b) =>
      compareStrings(a.file, b.file) ||
      compareStrings(a.entry.hash, b.entry.hash) ||
      compareStrings(a.entry.preview, b.entry.preview),
  );

  return {
    unbaselined,
    stale,
    shrunkBaseline: canonicalizeBaseline({ version: 1, files: nextFiles }),
  };
}
