/**
 * Markdown tables from a result bundle (for docs/results/controller-comparison.md):
 *   node src/lib/evaluation/courses/cli/report.ts evaluation/runs/<bundle>/results.json
 */
import { readFileSync } from "node:fs";
import type { ConditionSummary } from "../batch.ts";
import type { RunMetrics } from "../metrics.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: report.ts <results.json>");
const results = JSON.parse(readFileSync(path, "utf8")) as { summaries: ConditionSummary[]; runs: (RunMetrics & { condition: string })[]; wallS: number };
const pct = (v: number): string => `${Math.round(v * 100)}%`;
const fmt = (v: number | null, digits = 1): string => (v === null ? "–" : v.toFixed(digits));

console.log("| Condition | Completed (95% CI) | Collision-free completions | Mean path progress | Doorway passed | Debris passed | Collisions (runs with ≥1) | Median time to goal, s | False braking, s total (per run) | Median min gap, m | FlyVis steps > 20 ms / > 50 ms | End reasons |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const s of results.summaries) {
  const neural = s.neuralSteps > 0 ? `${s.neuralOver20Ms} / ${s.neuralOver50Ms} of ${s.neuralSteps}` : "n/a (no FlyVis)";
  const ends = Object.entries(s.endReasons).map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(`| ${s.condition} | ${s.completed}/${s.runs} = ${pct(s.completionRate)} (${pct(s.completionCi95[0])}–${pct(s.completionCi95[1])}) | ${s.collisionFreeCompletions}/${s.runs} | ${pct(s.meanProgress)} | ${s.doorwayPassed}/${s.runs} | ${s.debrisPassed}/${s.debrisRuns} | ${s.collisions} (${s.runsWithCollision}) | ${fmt(s.medianTimeToGoalS)} | ${fmt(s.falseBrakingS)} (${fmt(s.meanFalseBrakingS, 2)}) | ${fmt(s.medianMinGapM, 2)} | ${neural} | ${ends} |`);
}

// Paired view: per course, which conditions completed collision-free.
const conditions = results.summaries.map(s => s.condition);
const courses = [...new Set(results.runs.map(r => r.courseId))];
console.log(`\n| Course | ${conditions.join(" | ")} |`);
console.log(`| --- | ${conditions.map(() => "---").join(" | ")} |`);
for (const course of courses) {
  const cells = conditions.map(c => {
    const r = results.runs.find(x => x.courseId === course && x.condition === c);
    if (!r) return "–";
    return `${r.completed ? "✓" : "✗"}${r.collisions ? ` ${r.collisions}c` : ""}${r.completed ? ` ${r.timeToGoalS?.toFixed(1)}s` : ` ${Math.round(r.progress * 100)}%`}`;
  });
  console.log(`| ${course} | ${cells.join(" | ")} |`);
}
console.log(`\nwall ${results.wallS} s`);
