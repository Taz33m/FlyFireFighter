/**
 * Run controller conditions on a course split and save a result bundle.
 *
 *   node src/lib/evaluation/courses/cli/evaluate.ts --split test \
 *     --controllers flow_baseline,engineered_readout,fly_readout --assist both \
 *     --model models/readout/trained-readout-v1.json --flow-tuning models/readout/flow-baseline-tuning.json
 *
 * Bundle (default evaluation/runs/<UTC timestamp>-<split>/): config.json (seeds and split, course
 * scene hashes, controller/checkpoint/model hashes, calibration, renderer, harness policy, flow tuning,
 * thresholds), results.json (every run's metrics + per-condition summaries), events/<runId>.events.jsonl
 * (harness event log + truth events) and timings. Validation runs are for selection; test runs only for
 * the final held-out comparison.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { canonicalJson } from "../../../contracts/canonical.ts";
import { DEFAULT_POLICY } from "../../../harness/policy.ts";
import { HEADLESS_RENDERER_ID } from "../../../mission/headless-camera.ts";
import type { Condition } from "../batch.ts";
import { runBatch, summarize } from "../batch.ts";
import type { ControllerKind } from "../controllers.ts";
import { loadFlowTuning, loadReadoutModel } from "../controllers.ts";
import { codeState } from "../code-state.ts";
import { buildCourse, courseCalibration } from "../course.ts";
import { METRIC_THRESHOLDS } from "../metrics.ts";
import type { CourseSplit } from "../splits.ts";
import { COURSE_FAMILY, COURSE_SEEDS } from "../splits.ts";

const { values } = parseArgs({ options: {
  split: { type: "string", default: "validation" }, controllers: { type: "string", default: "flow_baseline,engineered_readout,fly_readout" },
  assist: { type: "string", default: "both" }, model: { type: "string" }, "flow-tuning": { type: "string" }, out: { type: "string" }, limit: { type: "string" }, label: { type: "string", default: "" },
} });
const split = values.split as CourseSplit;
const kinds = (values.controllers as string).split(",") as ControllerKind[];
const assists = values.assist === "both" ? [false, true] : [values.assist === "on"];
const conditions: Condition[] = kinds.flatMap(kind => assists.map(rangeAssist => ({ kind, rangeAssist })));
const model = values.model ? loadReadoutModel(values.model) : null;
const flowTuning = values["flow-tuning"] ? loadFlowTuning(values["flow-tuning"]) : null;
const seeds = COURSE_SEEDS[split].slice(0, values.limit ? Number(values.limit) : undefined);
const specs = seeds.map(seed => buildCourse(split, seed));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = values.out ?? join("evaluation", "runs", `${stamp}-${split}${values.label ? `-${values.label}` : ""}`);
mkdirSync(dir, { recursive: true });
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const config = {
  created: new Date().toISOString(), codeState: codeState(), split, family: COURSE_FAMILY, seeds,
  courses: specs.map(s => ({ courseId: s.courseId, seed: s.seed, attempt: s.attempt, sceneSha256: sha(canonicalJson(s.meta as never)), lengthM: s.layout.lengthM, widthM: s.layout.widthM, doorwayWidthM: s.layout.doorway.widthM, speedCapMps: s.speedCapMps, smokePerM: s.smokePerM, exposureGain: s.exposureGain, debris: s.debris !== null, budgetS: s.budgetS, calibrationId: courseCalibration(s).id })),
  conditions, renderer: HEADLESS_RENDERER_ID, harnessPolicyRevision: DEFAULT_POLICY.revision, thresholds: METRIC_THRESHOLDS,
  model: model ? { id: model.id, label: model.label, file: values.model, sha256: sha(readFileSync(values.model as string, "utf8")), checkpoint: model.checkpoint, selected: model.training.selected ?? null, dataHash: model.training.dataHash ?? null } : null,
  flowTuning: flowTuning ? { file: values["flow-tuning"], ...flowTuning } : null,
  engineeredReadout: kinds.includes("engineered_readout") ? "committed defaults (DEFAULT_ENGINEERED_WEIGHTS, DEFAULT_COMMAND_CONFIG); not tuned on courses" : null,
  approvalPolicy: "single routine move per run (no consequential actions; no commander approvals involved)",
};
writeFileSync(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
console.log(`bundle ${dir}: ${specs.length} courses × ${conditions.length} conditions`);
const result = await runBatch({ specs, conditions, flowTuning, model, eventsDir: join(dir, "events"), runPrefix: values.label || split, log: line => console.log(line) });
const summaries = summarize(result.runs);
writeFileSync(join(dir, "results.json"), `${JSON.stringify({ label: "simulation_evaluator (procedural courses, headless renderer)", split, checkpoint: result.checkpoint, wallS: result.wallS, summaries, runs: result.runs }, null, 2)}\n`);
for (const s of summaries) {
  console.log(`${s.condition.padEnd(26)} done ${s.completed}/${s.runs} (CI ${s.completionCi95.join("–")}) collFree ${s.collisionFreeCompletions} prog ${s.meanProgress} door ${s.doorwayPassed} debris ${s.debrisPassed}/${s.debrisRuns} coll ${s.collisions} (${s.runsWithCollision} runs) tMed ${s.medianTimeToGoalS} fb ${s.falseBrakingS}s gapMed ${s.medianMinGapM} neural>20ms ${s.neuralOver20Ms}/${s.neuralSteps} ends ${JSON.stringify(s.endReasons)}`);
}
console.log(`wall ${result.wallS} s -> ${dir}`);
