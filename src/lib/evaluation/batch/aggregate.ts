/**
 * Aggregate summary for a batch (summary.json). Honest denominators:
 * - every planned run is accounted for as ran, not run (a missing requirement), invalid (it ran but not as
 *   configured, e.g. the FlyVis readout fell back to the classical controller) or error;
 * - the primary metric's denominator is the runs that ran as configured; an unscored run (stopped by the
 *   tick cap before the evaluator ended it) counts as NOT completed and is listed;
 * - every incomplete run is listed with its label;
 * - a 95% Wilson interval is given only with at least MIN_RUNS_FOR_INTERVAL runs, otherwise null;
 * - paired comparisons are descriptive counts of concordant/discordant seeds. Nothing here claims an
 *   improvement; the summary says so explicitly.
 */
import type { InjectionRecord } from "./injections.ts";
import type { RunMetrics } from "./metrics.ts";
import type { Condition } from "./conditions.ts";

export const SUMMARY_SCHEMA = "flyfirefighter.mission-evaluation/1";
export const MIN_RUNS_FOR_INTERVAL = 10;

export type RunStatus = "ran" | "not_run" | "invalid" | "error";

export interface RunRecord {
  readonly runId: string;
  readonly seed: string;
  readonly conditionId: string;
  readonly status: RunStatus;
  /** Why the run did not run, was invalid or errored; null when it ran as configured. */
  readonly reason: string | null;
  readonly metrics: RunMetrics | null;
  readonly injection: InjectionRecord | null;
  readonly bundleDir: string | null;
  readonly eventsSha256: string | null;
  readonly controllerLabel: string | null;
}

export interface Distribution {
  readonly available: number;
  readonly of: number;
  readonly median: number | null;
  readonly min: number | null;
  readonly max: number | null;
}

export interface ConditionSummary {
  readonly conditionId: string;
  readonly expectation: string;
  readonly planned: number;
  readonly ran: number;
  readonly notRun: readonly { readonly runId: string; readonly reason: string }[];
  readonly invalid: readonly { readonly runId: string; readonly reason: string }[];
  readonly errors: readonly { readonly runId: string; readonly reason: string }[];
  readonly unscored: readonly string[];
  readonly completedRescue: { readonly completed: number; readonly of: number; readonly fraction: number | null; readonly wilson95: readonly [number, number] | null; readonly intervalNote: string };
  readonly incomplete: readonly { readonly runId: string; readonly label: string }[];
  readonly timeToFirstOccupantEvidenceS: Distribution;
  readonly timeToExteriorArrivalS: Distribution;
  readonly runsWithCollision: number;
  readonly collisions: number;
  readonly constraintViolations: number;
  readonly missionAborts: number;
  readonly recalls: number;
  readonly proposalAborts: number;
  readonly stallAborts: number;
  readonly contingencies: number;
  readonly waterDischargedL: Distribution;
  readonly unauthorizedActions: number;
  readonly blockedInterventions: number;
  readonly droneReturn: { readonly [result: string]: number };
  readonly injectionsApplied: number;
  readonly injectionsEffective: number;
  readonly wallS: Distribution;
  readonly simToWall: Distribution;
}

export interface PairSummary {
  readonly condition: string;
  readonly against: string;
  readonly factor: string;
  readonly pairs: number;
  readonly bothCompleted: number;
  readonly onlyCondition: number;
  readonly onlyReference: number;
  readonly neither: number;
  readonly unpairedSeeds: readonly string[];
}

export interface BatchSummary {
  readonly schema: typeof SUMMARY_SCHEMA;
  readonly label: string;
  readonly claims: "none — descriptive counts only; no improvement or generalization is claimed";
  readonly seeds: readonly string[];
  readonly totals: { readonly planned: number; readonly ran: number; readonly notRun: number; readonly invalid: number; readonly errors: number };
  readonly conditions: readonly ConditionSummary[];
  readonly pairs: readonly PairSummary[];
}

export function aggregate(records: readonly RunRecord[], conditions: readonly Condition[]): BatchSummary {
  const seeds = [...new Set(records.map(r => r.seed))];
  const present = conditions.filter(c => records.some(r => r.conditionId === c.id));
  return {
    schema: SUMMARY_SCHEMA,
    label: "simulation — single Troy training house, synthetic sensors, headless collider renderer, simplified fire model; not evidence of performance in unseen homes",
    claims: "none — descriptive counts only; no improvement or generalization is claimed",
    seeds,
    totals: {
      planned: records.length,
      ran: records.filter(r => r.status === "ran").length,
      notRun: records.filter(r => r.status === "not_run").length,
      invalid: records.filter(r => r.status === "invalid").length,
      errors: records.filter(r => r.status === "error").length,
    },
    conditions: present.map(c => summarizeCondition(c, records.filter(r => r.conditionId === c.id))),
    pairs: present.filter(c => c.pair !== null && present.some(p => p.id === c.pair?.against)).map(c => summarizePair(c, records)),
  };
}

function summarizeCondition(condition: Condition, records: readonly RunRecord[]): ConditionSummary {
  const ran = records.filter(r => r.status === "ran" && r.metrics !== null);
  const m = ran.map(r => r.metrics as RunMetrics);
  const completed = m.filter(x => x.completedRescue).length;
  const n = ran.length;
  const listed = (status: RunStatus) => records.filter(r => r.status === status).map(r => ({ runId: r.runId, reason: r.reason ?? "" }));
  const droneReturn: Record<string, number> = {};
  for (const x of m) droneReturn[x.droneReturn ?? "not_scored"] = (droneReturn[x.droneReturn ?? "not_scored"] ?? 0) + 1;
  return {
    conditionId: condition.id,
    expectation: condition.expectation,
    planned: records.length,
    ran: n,
    notRun: listed("not_run"),
    invalid: listed("invalid"),
    errors: listed("error"),
    unscored: ran.filter(r => !(r.metrics as RunMetrics).scored).map(r => r.runId),
    completedRescue: {
      completed,
      of: n,
      fraction: n === 0 ? null : completed / n,
      wilson95: n >= MIN_RUNS_FOR_INTERVAL ? wilson(completed, n) : null,
      intervalNote: n >= MIN_RUNS_FOR_INTERVAL ? "95% Wilson score interval" : `no interval: ${n} run(s) < ${MIN_RUNS_FOR_INTERVAL}`,
    },
    incomplete: ran.filter(r => !(r.metrics as RunMetrics).completedRescue).map(r => ({ runId: r.runId, label: (r.metrics as RunMetrics).rescueLabel ?? "not scored (tick cap reached)" })),
    timeToFirstOccupantEvidenceS: distribution(m.map(x => x.timeToFirstOccupantEvidenceS), n),
    timeToExteriorArrivalS: distribution(m.map(x => x.timeToExteriorArrivalS), n),
    runsWithCollision: m.filter(x => x.collisions > 0).length,
    collisions: sum(m.map(x => x.collisions)),
    constraintViolations: sum(m.map(x => x.constraintViolations)),
    missionAborts: sum(m.map(x => x.missionAborts)),
    proposalAborts: sum(m.map(x => x.proposalAborts)),
    stallAborts: sum(m.map(x => x.stallAborts)),
    recalls: sum(m.map(x => x.recalls)),
    contingencies: sum(m.map(x => x.contingencies)),
    waterDischargedL: distribution(m.map(x => x.waterDischargedL), n),
    unauthorizedActions: sum(m.map(x => x.unauthorizedActions)),
    blockedInterventions: sum(m.map(x => x.blockedInterventions)),
    droneReturn,
    injectionsApplied: ran.filter(r => r.injection?.applied === true).length,
    injectionsEffective: ran.filter(r => r.injection?.effective === true).length,
    wallS: distribution(m.map(x => x.wallS), n),
    simToWall: distribution(m.map(x => x.simToWall), n),
  };
}

function summarizePair(condition: Condition, records: readonly RunRecord[]): PairSummary {
  const pair = condition.pair as NonNullable<Condition["pair"]>;
  const ranBy = (id: string) => new Map(records.filter(r => r.conditionId === id && r.status === "ran" && r.metrics !== null).map(r => [r.seed, (r.metrics as RunMetrics).completedRescue]));
  const a = ranBy(condition.id);
  const b = ranBy(pair.against);
  const seeds = [...new Set([...records.filter(r => r.conditionId === condition.id || r.conditionId === pair.against).map(r => r.seed)])];
  let bothCompleted = 0, onlyCondition = 0, onlyReference = 0, neither = 0;
  const unpairedSeeds: string[] = [];
  for (const seed of seeds) {
    const x = a.get(seed);
    const y = b.get(seed);
    if (x === undefined || y === undefined) {
      unpairedSeeds.push(seed);
      continue;
    }
    if (x && y) bothCompleted++;
    else if (x) onlyCondition++;
    else if (y) onlyReference++;
    else neither++;
  }
  return { condition: condition.id, against: pair.against, factor: pair.factor, pairs: bothCompleted + onlyCondition + onlyReference + neither, bothCompleted, onlyCondition, onlyReference, neither, unpairedSeeds };
}

export function distribution(values: readonly (number | null)[], of: number): Distribution {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((p, q) => p - q);
  if (xs.length === 0) return { available: 0, of, median: null, min: null, max: null };
  const mid = Math.floor(xs.length / 2);
  const median = xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  return { available: xs.length, of, median: round(median), min: xs[0], max: xs[xs.length - 1] };
}

/** 95% Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number, z = 1.959964): readonly [number, number] {
  if (n <= 0 || k < 0 || k > n) throw new RangeError(`Invalid proportion ${k}/${n}`);
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [round(Math.max(0, centre - half)), round(Math.min(1, centre + half))];
}

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
