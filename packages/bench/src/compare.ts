import { readFileSync } from "node:fs";
import { groups, qualityGate, summarize, type RunFile } from "./stats.ts";

/*
 * bun run bench:compare baseline-1.json baseline-2.json baseline-3.json candidate.json
 *
 * Every file but the last is the baseline; the last is the candidate. Prints speed and quality per
 * engine and suite, then the quality gate: exit 1 when any pass rate or judge score falls below the
 * worst baseline run.
 */

const files = process.argv.slice(2);
if (files.length < 2) {
  console.error("Give one or more baseline results files, then the candidate's.");
  process.exit(2);
}
const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as RunFile;
const baselines = files.slice(0, -1).map(read);
const candidate = read(files.at(-1)!);

const seconds = (ms: number | null) => (ms === null ? "-" : `${(ms / 1000).toFixed(1)}s`);
const change = (before: number | null, after: number | null) => (before === null || after === null || before === 0 ? "" : ` (${after <= before ? "" : "+"}${(((after - before) / before) * 100).toFixed(0)}%)`);

const baseRuns = baselines.flatMap((file) => file.runs);
const baseGroups = groups(baseRuns);
console.log(`Baseline: ${baselines.map((f) => `${f.label} @ ${f.commit ?? "?"}`).join(", ")}`);
console.log(`Candidate: ${candidate.label} @ ${candidate.commit ?? "?"}\n`);

for (const [group, runs] of groups(candidate.runs)) {
  const before = baseGroups.get(group);
  if (!before) continue;
  const a = summarize(before);
  const b = summarize(runs);
  console.log(group);
  console.log(`  pass         ${(a.passRate * 100).toFixed(0)}% -> ${(b.passRate * 100).toFixed(0)}%`);
  console.log(`  judge        ${a.judgeMean?.toFixed(2) ?? "-"} -> ${b.judgeMean?.toFixed(2) ?? "-"}`);
  console.log(`  first words  ${seconds(a.firstWords.median)} -> ${seconds(b.firstWords.median)}${change(a.firstWords.median, b.firstWords.median)}   p90 ${seconds(a.firstWords.p90)} -> ${seconds(b.firstWords.p90)}`);
  console.log(`  done         ${seconds(a.done.median)} -> ${seconds(b.done.median)}${change(a.done.median, b.done.median)}   p90 ${seconds(a.done.p90)} -> ${seconds(b.done.p90)}`);
  if (a.route.median !== null || b.route.median !== null) console.log(`  routed       ${seconds(a.route.median)} -> ${seconds(b.route.median)}${change(a.route.median, b.route.median)}`);
  console.log(`  cached input ${a.cacheShare === null ? "-" : `${(a.cacheShare * 100).toFixed(0)}%`} -> ${b.cacheShare === null ? "-" : `${(b.cacheShare * 100).toFixed(0)}%`}\n`);
}

const findings = qualityGate(baselines, candidate);
if (!findings.length) {
  console.log("Quality gate: held. No pass rate or judge score fell below the worst baseline run.");
  process.exit(0);
}
console.log("Quality gate: FAILED");
for (const f of findings) console.log(`  ${f.group}: ${f.what} ${f.what === "pass rate" ? `${(f.candidate * 100).toFixed(0)}% < ${(f.baselineFloor * 100).toFixed(0)}%` : `${f.candidate.toFixed(2)} < ${f.baselineFloor.toFixed(2)}`}`);
process.exit(1);
