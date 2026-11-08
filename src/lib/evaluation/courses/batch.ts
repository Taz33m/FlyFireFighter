/**
 * Batches of course runs for tuning and the held-out comparison, plus per-condition summaries.
 *
 * Every condition runs the same course specs (same seeds → same layout, sequence, smoke, debris trigger,
 * camera read noise and sensor noise keyed by seed and tick), the same harness and the same goals;
 * trajectories diverge naturally. FlyVis conditions share one service connection, reset per run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TrainedReadoutModel } from "../../navigation/reflex/trained-readout.ts";
import type { CourseSpec } from "./course.ts";
import type { ControllerKind, FlowTuning } from "./controllers.ts";
import { makeController, needsNeural } from "./controllers.ts";
import type { RunMetrics } from "./metrics.ts";
import { ServiceNeuralSource } from "./neural-source.ts";
import type { FeatureHolder } from "./runner.ts";
import { runCourse } from "./runner.ts";

export interface Condition {
  readonly kind: ControllerKind;
  readonly rangeAssist: boolean;
}

export const conditionName = (c: Condition): string => `${c.kind}${c.rangeAssist ? "+range" : ""}`;

export interface BatchOptions {
  readonly specs: readonly CourseSpec[];
  readonly conditions: readonly Condition[];
  readonly flowTuning: FlowTuning | null;
  readonly model: TrainedReadoutModel | null;
  /** When set, each run's events.jsonl is written to <eventsDir>/<runId>.events.jsonl. */
  readonly eventsDir?: string;
  readonly runPrefix: string;
  readonly log?: (line: string) => void;
}

export interface BatchResult {
  readonly runs: readonly (RunMetrics & { readonly condition: string; readonly wallS: number })[];
  readonly checkpoint: { readonly name: string; readonly checkpointSha256: string } | null;
  readonly wallS: number;
}

export async function runBatch(o: BatchOptions): Promise<BatchResult> {
  const started = performance.now();
  const holder: FeatureHolder = { current: null };
  // Connected lazily, right before the first FlyVis condition: flow-only runs never yield to the event loop,
  // so an idle socket opened earlier would miss the service's keep-alive pings and be closed.
  let neural: ServiceNeuralSource | null = null;
  const runs: BatchResult["runs"][number][] = [];
  if (o.eventsDir) mkdirSync(o.eventsDir, { recursive: true });
  try {
    for (const condition of o.conditions) {
      const controller = makeController(condition.kind, holder, { flowTuning: o.flowTuning, model: o.model });
      if (needsNeural(condition.kind) && neural === null) neural = await ServiceNeuralSource.connect();
      for (const spec of o.specs) {
        const runId = `${o.runPrefix}-${conditionName(condition)}-${spec.courseId}`.slice(0, 64);
        const t0 = performance.now();
        const { metrics, eventsJsonl } = await runCourse({ spec, runId, controller, neural: needsNeural(condition.kind) ? neural : null, features: holder, rangeAssist: condition.rangeAssist, driver: { kind: "controller" } });
        const wallS = Math.round((performance.now() - t0) / 100) / 10;
        if (o.eventsDir) writeFileSync(join(o.eventsDir, `${runId}.events.jsonl`), eventsJsonl);
        runs.push({ ...metrics, condition: conditionName(condition), wallS });
        o.log?.(`${runId} ${metrics.endReason} t=${metrics.durationS}s coll=${metrics.collisions} fb=${metrics.falseBrakingS}s gap=${metrics.minGapM} wall=${wallS}s`);
      }
    }
  } finally {
    await neural?.close();
  }
  const ready = (neural as ServiceNeuralSource | null)?.ready?.model ?? null;
  return { runs, checkpoint: ready ? { name: ready.name, checkpointSha256: ready.checkpointSha256 } : null, wallS: Math.round((performance.now() - started) / 1000) };
}

/** Wilson score interval for k successes in n trials (95 %). */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.959964;
  const p = k / n;
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r3 = (v: number | null): number | null => (v === null ? null : Math.round(v * 1000) / 1000);

export interface ConditionSummary {
  readonly condition: string;
  readonly runs: number;
  readonly completed: number;
  readonly completionRate: number;
  readonly completionCi95: [number, number];
  readonly collisionFreeCompletions: number;
  readonly collisions: number;
  readonly runsWithCollision: number;
  readonly medianTimeToGoalS: number | null;
  readonly meanTimeToGoalS: number | null;
  readonly falseBrakingS: number;
  readonly meanFalseBrakingS: number;
  readonly medianMinGapM: number | null;
  readonly meanProgress: number;
  readonly doorwayPassed: number;
  readonly debrisPassed: number;
  readonly debrisRuns: number;
  readonly endReasons: Readonly<Record<string, number>>;
  readonly neuralSteps: number;
  readonly neuralOver20Ms: number;
  readonly neuralOver50Ms: number;
  readonly neuralP95Ms: number | null;
  readonly controllerOver20Ms: number;
  readonly controllerP95Ms: number | null;
}

export function summarize(runs: BatchResult["runs"]): ConditionSummary[] {
  const names = [...new Set(runs.map(r => r.condition))];
  return names.map(condition => {
    const rs = runs.filter(r => r.condition === condition);
    const done = rs.filter(r => r.completed);
    const times = done.map(r => r.timeToGoalS as number);
    const endReasons: Record<string, number> = {};
    for (const r of rs) endReasons[r.endReason] = (endReasons[r.endReason] ?? 0) + 1;
    const neural = rs.map(r => r.neural).filter(n => n !== null);
    return {
      condition, runs: rs.length, completed: done.length, completionRate: r3(done.length / Math.max(1, rs.length)) as number,
      completionCi95: wilson(done.length, rs.length).map(v => r3(v) as number) as [number, number],
      collisionFreeCompletions: done.filter(r => r.collisions === 0).length, collisions: rs.reduce((s, r) => s + r.collisions, 0), runsWithCollision: rs.filter(r => r.collisions > 0).length,
      medianTimeToGoalS: r3(median(times)), meanTimeToGoalS: r3(times.length ? times.reduce((a, b) => a + b, 0) / times.length : null),
      falseBrakingS: r3(rs.reduce((s, r) => s + r.falseBrakingS, 0)) as number, meanFalseBrakingS: r3(rs.reduce((s, r) => s + r.falseBrakingS, 0) / Math.max(1, rs.length)) as number,
      medianMinGapM: r3(median(rs.map(r => r.minGapM))), endReasons,
      meanProgress: r3(rs.reduce((s, r) => s + r.progress, 0) / Math.max(1, rs.length)) as number, doorwayPassed: rs.filter(r => r.doorwayPassed).length,
      debrisPassed: rs.filter(r => r.debrisPassed === true).length, debrisRuns: rs.filter(r => r.debrisPassed !== null).length,
      neuralSteps: neural.reduce((s, n) => s + n.count, 0), neuralOver20Ms: neural.reduce((s, n) => s + n.over20Ms, 0), neuralOver50Ms: neural.reduce((s, n) => s + n.over50Ms, 0),
      neuralP95Ms: neural.length ? r3(Math.max(...neural.map(n => n.p95Ms))) : null,
      controllerOver20Ms: rs.reduce((s, r) => s + r.controllerTiming.over20Ms, 0), controllerP95Ms: r3(Math.max(...rs.map(r => r.controllerTiming.p95Ms))),
    };
  });
}

/**
 * Scalar tuning score: collision-free completion 1, completion with contact 0.5, otherwise 0.3 × planned-path
 * progress; minus 0.1 per collision. A controller that never moves scores 0.
 */
export function tuningScore(runs: readonly RunMetrics[]): number {
  return runs.reduce((s, r) => s + (r.completed ? (r.collisions === 0 ? 1 : 0.5) : 0.3 * r.progress) - 0.1 * r.collisions, 0);
}
