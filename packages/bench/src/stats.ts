export type CaseRun = {
  suite: string;
  name: string;
  engine: string;
  repeat: number;
  run: string;
  pass: boolean;
  checks: Record<string, boolean>;
  score: number | null;
  judgeReason: string | null;
  /** POST to the first words on screen, as the person sees it. */
  firstWordsMs: number | null;
  /** POST to the end of the last turn. */
  doneMs: number | null;
  setupMs: number | null;
  queuedMs: number | null;
  routeMs: number | null;
  launch: string | null;
  rounds: number;
  screen: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  timedOut: boolean;
  error: string | null;
  /** What the bots answered (cut to 4,000 characters), to read back why a check missed. */
  answer?: string;
};

export type RunFile = {
  label: string;
  startedAt: string;
  gondUrl: string;
  commit: string | null;
  models: Record<string, string>;
  runs: CaseRun[];
};

export function quantile(values: number[], q: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

export type Summary = {
  n: number;
  passRate: number;
  judgeMean: number | null;
  judged: number;
  firstWords: { median: number | null; p90: number | null };
  done: { median: number | null; p90: number | null };
  route: { median: number | null; p90: number | null };
  cacheShare: number | null;
};

export function summarize(runs: CaseRun[]): Summary {
  const scores = runs.flatMap((r) => (r.score === null ? [] : [r.score]));
  const first = runs.flatMap((r) => (r.firstWordsMs === null ? [] : [r.firstWordsMs]));
  const done = runs.flatMap((r) => (r.doneMs === null ? [] : [r.doneMs]));
  const route = runs.flatMap((r) => (r.routeMs === null ? [] : [r.routeMs]));
  const read = runs.reduce((sum, r) => sum + r.tokens.cacheRead, 0);
  const all = runs.reduce((sum, r) => sum + r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite, 0);
  return {
    n: runs.length,
    passRate: runs.length ? runs.filter((r) => r.pass).length / runs.length : 0,
    judgeMean: mean(scores),
    judged: scores.length,
    firstWords: { median: quantile(first, 0.5), p90: quantile(first, 0.9) },
    done: { median: quantile(done, 0.5), p90: quantile(done, 0.9) },
    route: { median: quantile(route, 0.5), p90: quantile(route, 0.9) },
    cacheShare: all ? read / all : null,
  };
}

/** Runs grouped by engine and suite, the unit the quality gate judges. */
export function groups(runs: CaseRun[]): Map<string, CaseRun[]> {
  const out = new Map<string, CaseRun[]>();
  for (const run of runs) {
    const key = `${run.engine} / ${run.suite}`;
    out.set(key, [...(out.get(key) ?? []), run]);
  }
  return out;
}

export type GateFinding = { group: string; what: "pass rate" | "judge score"; baselineFloor: number; candidate: number };

/**
 * Where the candidate's quality falls below the worst of the baseline's runs, per engine and suite.
 * The baseline's own runs set the floor, so run-to-run noise in the baseline isn't counted as a drop;
 * with one baseline run any drop counts.
 */
export function qualityGate(baselines: RunFile[], candidate: RunFile): GateFinding[] {
  const findings: GateFinding[] = [];
  const candidateGroups = groups(candidate.runs);
  const keys = new Set(baselines.flatMap((file) => [...groups(file.runs).keys()]));
  for (const key of keys) {
    const theirs = candidateGroups.get(key);
    if (!theirs?.length) continue;
    const base = baselines.map((file) => groups(file.runs).get(key) ?? []).filter((runs) => runs.length);
    const cand = summarize(theirs);
    const passFloor = Math.min(...base.map((runs) => summarize(runs).passRate));
    if (cand.passRate < passFloor - 1e-9) findings.push({ group: key, what: "pass rate", baselineFloor: passFloor, candidate: cand.passRate });
    const judged = base.map((runs) => summarize(runs).judgeMean).filter((m): m is number => m !== null);
    if (judged.length && cand.judgeMean !== null) {
      const judgeFloor = Math.min(...judged);
      if (cand.judgeMean < judgeFloor - 1e-9) findings.push({ group: key, what: "judge score", baselineFloor: judgeFloor, candidate: cand.judgeMean });
    }
  }
  return findings;
}
