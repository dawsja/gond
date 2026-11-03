import { describe, expect, test } from "bun:test";
import { qualityGate, quantile, summarize, type CaseRun, type RunFile } from "../src/stats.ts";

const caseRun = (over: Partial<CaseRun>): CaseRun => ({
  suite: "chat",
  name: "short fact",
  engine: "api",
  repeat: 1,
  run: "r",
  pass: true,
  checks: {},
  score: null,
  judgeReason: null,
  firstWordsMs: 1000,
  doneMs: 2000,
  setupMs: 100,
  queuedMs: 10,
  routeMs: null,
  launch: null,
  rounds: 1,
  screen: 0,
  tokens: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0 },
  timedOut: false,
  error: null,
  ...over,
});

const file = (runs: CaseRun[]): RunFile => ({ label: "x", startedAt: "", gondUrl: "", commit: null, models: {}, runs });

describe("the benchmark's numbers", () => {
  test("quantiles interpolate and skip what wasn't measured", () => {
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNull();
    const summary = summarize([caseRun({ firstWordsMs: null }), caseRun({ firstWordsMs: 3000, pass: false, score: 4 })]);
    expect(summary).toMatchObject({ n: 2, passRate: 0.5, judgeMean: 4, firstWords: { median: 3000 }, cacheShare: 0.9 });
  });

  test("a candidate is flagged only below the worst baseline run, per engine and suite", () => {
    const base = [file([caseRun({ score: 5 }), caseRun({ score: 4 })]), file([caseRun({ score: 4 }), caseRun({ score: 4, pass: false })])];
    // Pass rate 0.5 and judge 4 equal the worst baseline run: not a drop.
    expect(qualityGate(base, file([caseRun({ score: 4 }), caseRun({ score: 4, pass: false })]))).toEqual([]);
    const worse = qualityGate(base, file([caseRun({ score: 3, pass: false }), caseRun({ score: 4, pass: false })]));
    expect(worse.map((f) => f.what)).toEqual(["pass rate", "judge score"]);
    // A suite the candidate didn't run isn't judged.
    expect(qualityGate(base, file([caseRun({ suite: "rooms", pass: false })]))).toEqual([]);
  });
});
