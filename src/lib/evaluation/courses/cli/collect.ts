/**
 * Collect readout training data on TRAIN (or VALIDATION) courses with the live FlyVis service.
 *
 *   node src/lib/evaluation/courses/cli/collect.ts --part train-r0 --split train --driver dart
 *   node src/lib/evaluation/courses/cli/collect.ts --part train-r1 --split train --driver mixture --beta 0.5 --model <json>
 *
 * Drivers: teacher (truth teacher flies), dart (teacher with keyed perturbations; labels stay clean),
 * mixture (DAgger: per 0.5 s segment the teacher flies with probability β, else the trained readout),
 * learner (β = 0). Every visual step is labelled with the teacher's command. Never run on the test split.
 * Requires the FlyVis service on 127.0.0.1:3201 (one instance).
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { codeState } from "../code-state.ts";
import { buildCourse } from "../course.ts";
import { loadReadoutModel, trainedController } from "../controllers.ts";
import type { ShardEntry } from "../dataset.ts";
import { DATASET_COLUMNS, ShardBuffer, writeManifest } from "../dataset.ts";
import { ServiceNeuralSource } from "../neural-source.ts";
import type { Driver, FeatureHolder } from "../runner.ts";
import { runCourse } from "../runner.ts";
import type { CourseSplit } from "../splits.ts";
import { COURSE_SEEDS } from "../splits.ts";

const { values } = parseArgs({ options: { part: { type: "string" }, split: { type: "string", default: "train" }, driver: { type: "string", default: "dart" }, beta: { type: "string", default: "0" }, model: { type: "string" }, out: { type: "string", default: "datasets/generated/readout-v1" }, limit: { type: "string" } } });
const split = values.split as CourseSplit;
if (split !== "train" && split !== "validation") throw new Error("collect runs on train or validation only");
if (!values.part) throw new Error("--part is required");
const beta = Number(values.beta);
const driverName = values.driver as string;
const driver: Driver = driverName === "teacher" ? { kind: "teacher" }
  : driverName === "dart" ? { kind: "teacher", noise: { forwardSigma: 0.2, yawSigma: 0.35, holdTicks: 30 } }
  : driverName === "mixture" ? { kind: "mixture", beta, segmentTicks: 50 }
  : driverName === "learner" ? { kind: "controller" } : (() => { throw new Error(`unknown driver ${driverName}`); })();
const holder: FeatureHolder = { current: null };
const model = values.model ? loadReadoutModel(values.model) : null;
const controller = model ? trainedController(holder, model) : null;
if ((driver.kind === "mixture" || driver.kind === "controller") && !controller) throw new Error("mixture/learner drivers need --model");

const dir = join(values.out as string, values.part);
const seeds = COURSE_SEEDS[split].slice(0, values.limit ? Number(values.limit) : undefined);
const neural = await ServiceNeuralSource.connect();
const started = performance.now();
const shards: ShardEntry[] = [];
try {
  for (const seed of seeds) {
    const spec = buildCourse(split, seed);
    const runId = `${values.part}-${spec.courseId}`;
    const buffer = new ShardBuffer();
    const t0 = performance.now();
    const { metrics } = await runCourse({ spec, runId, controller: driver.kind === "teacher" ? null : controller, neural, features: holder, rangeAssist: false, driver, onSample: s => buffer.add(s) });
    const written = buffer.write(dir, runId);
    shards.push({ runId, courseId: spec.courseId, split, driver: driverName, rows: written.rows, file: written.file, sha256: written.sha256, endReason: metrics.endReason, collisions: metrics.collisions });
    console.log(`${runId} ${metrics.endReason} t=${metrics.durationS}s coll=${metrics.collisions} rows=${written.rows} wall=${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }
} finally {
  await neural.close();
}
const wallS = (performance.now() - started) / 1000;
writeManifest(dir, {
  part: values.part, created: new Date().toISOString(), codeState: codeState(), split, driver: driverName, beta, model: model ? { id: model.id, file: values.model, training: model.training.dataHash ?? null } : null,
  checkpoint: neural.ready?.model ?? null, renderer: "headless-collider/v1", columns: DATASET_COLUMNS, shards, wallS: Math.round(wallS),
});
console.log(`part ${values.part}: ${shards.length} runs, ${shards.reduce((s, r) => s + r.rows, 0)} rows, ${shards.filter(r => r.endReason === "completed").length} completed, wall ${wallS.toFixed(0)} s`);
