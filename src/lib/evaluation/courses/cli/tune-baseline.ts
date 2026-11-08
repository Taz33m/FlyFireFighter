/**
 * Tune the conventional optical-flow baseline on TRAIN and VALIDATION courses only (never test).
 *
 *   node src/lib/evaluation/courses/cli/tune-baseline.ts [--train 12] [--top 2]
 *
 * Stage 1: every candidate on the first N train courses without range assistance; stage 2: the top
 * candidates on all validation courses with and without range assistance; the selected configuration has
 * the highest validation tuningScore (batch.ts: collision-free completion 1, completion with contact 0.5,
 * otherwise 0.3 × path progress, −0.1 per collision; ties → lower mean time to goal). Writes models/readout/flow-baseline-tuning.json.
 * Candidates vary the committed defaults where the headless frames need it: the Lucas–Kanade texture
 * threshold (minEigen), the visual-confidence ramp of the shared mapper, and braking/steering gains.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { runBatch, summarize, tuningScore } from "../batch.ts";
import type { FlowTuning } from "../controllers.ts";
import { codeState } from "../code-state.ts";
import { buildCourse } from "../course.ts";
import { COURSE_SEEDS } from "../splits.ts";

const { values } = parseArgs({ options: { train: { type: "string", default: "12" }, top: { type: "string", default: "2" }, out: { type: "string", default: "models/readout/flow-baseline-tuning.json" } } });

const CANDIDATES: Readonly<Record<string, FlowTuning>> = {
  defaults: { flow: {}, command: {} },
  "eig1e-5-vis0.03": { flow: { minEigen: 1e-5 }, command: { minVisualConfidence: 0.03, fullVisualConfidence: 0.2 } },
  "eig3e-6-vis0.03": { flow: { minEigen: 3e-6 }, command: { minVisualConfidence: 0.03, fullVisualConfidence: 0.2 } },
  "eig3e-6-vis0.01": { flow: { minEigen: 3e-6 }, command: { minVisualConfidence: 0.01, fullVisualConfidence: 0.1 } },
  "eig1e-5-vis0.03-brake": { flow: { minEigen: 1e-5 }, command: { minVisualConfidence: 0.03, fullVisualConfidence: 0.2, brakeTimeS: 0.8, stopDistanceM: 0.6 } },
  "eig3e-6-vis0.03-steer": { flow: { minEigen: 3e-6 }, command: { minVisualConfidence: 0.03, fullVisualConfidence: 0.2, centeringGain: 1.5, avoidGain: 1.2 } },
};

const started = performance.now();
const train = COURSE_SEEDS.train.slice(0, Number(values.train)).map(seed => buildCourse("train", seed));
const validation = COURSE_SEEDS.validation.map(seed => buildCourse("validation", seed));
const stage1: { name: string; score: number; meanTime: number }[] = [];
for (const [name, tuning] of Object.entries(CANDIDATES)) {
  const result = await runBatch({ specs: train, conditions: [{ kind: "flow_baseline", rangeAssist: false }], flowTuning: tuning, model: null, runPrefix: `tune-${name}` });
  const done = result.runs.filter(r => r.completed);
  stage1.push({ name, score: tuningScore(result.runs), meanTime: done.length ? done.reduce((s, r) => s + (r.timeToGoalS ?? 0), 0) / done.length : Infinity });
  console.log(`stage1 ${name}: score ${tuningScore(result.runs).toFixed(2)} completed ${done.length}/${result.runs.length} collisions ${result.runs.reduce((s, r) => s + r.collisions, 0)} wall ${result.wallS}s`);
}
const ranked = [...stage1].sort((a, b) => b.score - a.score || a.meanTime - b.meanTime);
const stage2: { name: string; score: number; meanTime: number; summaries: ReturnType<typeof summarize> }[] = [];
for (const { name } of ranked.slice(0, Number(values.top))) {
  const result = await runBatch({ specs: validation, conditions: [{ kind: "flow_baseline", rangeAssist: false }, { kind: "flow_baseline", rangeAssist: true }], flowTuning: CANDIDATES[name], model: null, runPrefix: `tunev-${name}` });
  const done = result.runs.filter(r => r.completed);
  const entry = { name, score: tuningScore(result.runs), meanTime: done.length ? done.reduce((s, r) => s + (r.timeToGoalS ?? 0), 0) / done.length : Infinity, summaries: summarize(result.runs) };
  stage2.push(entry);
  console.log(`stage2 ${name}: validation score ${entry.score.toFixed(2)} completed ${done.length}/${result.runs.length} wall ${result.wallS}s`);
}
const best = [...stage2].sort((a, b) => b.score - a.score || a.meanTime - b.meanTime)[0];
const wallS = Math.round((performance.now() - started) / 1000);
mkdirSync(dirname(values.out as string), { recursive: true });
writeFileSync(values.out as string, `${JSON.stringify({
  schema: "flyfirefighter.flow-baseline-tuning/1", created: new Date().toISOString(), codeState: codeState(), selectedName: best.name, selected: CANDIDATES[best.name],
  selection: "highest validation tuningScore over 12 validation courses × {no range, range} after a 12-train-course screen; test courses never used",
  trainCourses: train.map(s => s.courseId), validationCourses: validation.map(s => s.courseId),
  stage1, stage2: stage2.map(({ name, score, meanTime, summaries }) => ({ name, score, meanTime: Number.isFinite(meanTime) ? meanTime : null, summaries })), candidates: CANDIDATES, wallS,
}, null, 2)}\n`);
console.log(`selected ${best.name} (wall ${wallS} s) -> ${values.out}`);
