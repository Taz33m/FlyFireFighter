/**
 * Batch aggregation (summary.json). Scope: denominators and accounting of every planned run, listing of
 * incomplete and unscored runs, intervals only at sufficient sample size, and descriptive (claim-free)
 * paired counts. Uses hand-built run records, not missions.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunRecord } from "./aggregate.ts";
import { aggregate, distribution, MIN_RUNS_FOR_INTERVAL, wilson } from "./aggregate.ts";
import { BASELINE_ID, CONDITIONS } from "./conditions.ts";
import type { RunMetrics } from "./metrics.ts";

function metrics(over: Partial<RunMetrics> = {}): RunMetrics {
  return {
    scored: true, completedRescue: true, rescueLabel: "simulated_evacuation_completed", endedTick: 30_000,
    timeToFirstOccupantEvidenceS: 60, timeToExteriorArrivalS: 240, collisions: 0, constraintViolations: 0, violationsByKind: {},
    missionAborts: 0, recalls: 1, proposalAborts: 0, stallAborts: 0, contingencies: 1, contingencyTriggers: ["mission_aborted"], waterDischargedL: 0.6, payloadsReleased: 0,
    unauthorizedActions: 0, blockedInterventions: 0, blockedByRule: {}, commandRefusals: 0, controllerFallbacks: 0,
    droneReturn: "returned", simulatedS: 300, wallS: 100, simToWall: 3, ...over,
  };
}

const INCOMPLETE = { completedRescue: false, rescueLabel: "incomplete_human_assistance_needed", timeToExteriorArrivalS: null } as const;

function record(conditionId: string, seed: string, over: Partial<RunRecord> = {}): RunRecord {
  return { runId: `ev-${conditionId}-${seed}`, seed, conditionId, status: "ran", reason: null, metrics: metrics(), injection: null, bundleDir: null, eventsSha256: "x", controllerLabel: "Optical-flow baseline", ...over };
}

describe("batch aggregate", () => {
  test("the primary metric's denominator is the runs that ran; unscored runs count as incomplete and every planned run is accounted for", () => {
    const records: RunRecord[] = [
      record(BASELINE_ID, "s1"),
      record(BASELINE_ID, "s2", { metrics: metrics({ ...INCOMPLETE, collisions: 1, constraintViolations: 1, violationsByKind: { collision: 1 } }) }),
      record(BASELINE_ID, "s3", { metrics: metrics({ scored: false, completedRescue: false, rescueLabel: null, droneReturn: null, timeToExteriorArrivalS: null }) }),
      record(BASELINE_ID, "s4", { status: "error", reason: "boom", metrics: null }),
      record("main.readout", "s1", { status: "not_run", reason: "Not run: the FlyVis service was unavailable", metrics: null }),
      record("main.readout", "s2", { status: "invalid", reason: "fell back", metrics: metrics() }),
    ];
    const summary = aggregate(records, CONDITIONS);
    assert.deepEqual(summary.totals, { planned: 6, ran: 3, notRun: 1, invalid: 1, errors: 1 });
    const base = summary.conditions.find(c => c.conditionId === BASELINE_ID);
    assert.ok(base);
    assert.equal(base.planned, 4);
    assert.deepEqual({ completed: base.completedRescue.completed, of: base.completedRescue.of }, { completed: 1, of: 3 });
    assert.deepEqual(base.unscored, [`ev-${BASELINE_ID}-s3`]);
    assert.deepEqual(base.incomplete.map(i => i.runId).sort(), [`ev-${BASELINE_ID}-s2`, `ev-${BASELINE_ID}-s3`]);
    assert.match(base.incomplete.find(i => i.runId.endsWith("s3"))?.label ?? "", /not scored/);
    assert.deepEqual(base.errors, [{ runId: `ev-${BASELINE_ID}-s4`, reason: "boom" }]);
    assert.equal(base.runsWithCollision, 1);
    assert.deepEqual({ available: base.timeToExteriorArrivalS.available, of: base.timeToExteriorArrivalS.of }, { available: 1, of: 3 }, "speed is reported with its own denominator");
    const readout = summary.conditions.find(c => c.conditionId === "main.readout");
    assert.ok(readout);
    assert.equal(readout.completedRescue.of, 0, "an invalid (fallback) run never enters the readout arm's denominator");
    assert.equal(readout.completedRescue.fraction, null);
    assert.equal(readout.notRun.length, 1);
    assert.equal(readout.invalid.length, 1);
  });

  test("an interval is reported only with enough runs", () => {
    const few = aggregate([record(BASELINE_ID, "s1")], CONDITIONS).conditions[0].completedRescue;
    assert.equal(few.wilson95, null);
    assert.match(few.intervalNote, /no interval/);
    const many = Array.from({ length: MIN_RUNS_FOR_INTERVAL }, (_, i) => record(BASELINE_ID, `s${i}`, i % 3 === 0 ? { metrics: metrics(INCOMPLETE) } : {}));
    const ci = aggregate(many, CONDITIONS).conditions[0].completedRescue;
    assert.ok(ci.wilson95 !== null && ci.fraction !== null);
    assert.ok(ci.wilson95[0] < ci.fraction && ci.fraction < ci.wilson95[1]);
    assert.deepEqual(wilson(0, 10).map(x => x >= 0 && x <= 1), [true, true]);
    assert.throws(() => wilson(3, 2));
  });

  test("paired comparisons are descriptive counts over seeds where both arms ran, with no improvement claim", () => {
    const records: RunRecord[] = [
      record(BASELINE_ID, "s1"), record("immobile.flow", "s1", { metrics: metrics(INCOMPLETE) }),
      record(BASELINE_ID, "s2", { metrics: metrics(INCOMPLETE) }), record("immobile.flow", "s2", { metrics: metrics(INCOMPLETE) }),
      record(BASELINE_ID, "s3"), record("immobile.flow", "s3", { status: "error", reason: "x", metrics: null }),
    ];
    const summary = aggregate(records, CONDITIONS);
    assert.deepEqual(summary.pairs, [{ condition: "immobile.flow", against: BASELINE_ID, factor: "variant: immobile occupant", pairs: 2, bothCompleted: 0, onlyCondition: 0, onlyReference: 1, neither: 1, unpairedSeeds: ["s3"] }]);
    assert.match(summary.claims, /^none/);
    const text = JSON.stringify({ ...summary, claims: null }).toLowerCase(); // the disclaimer itself names what is not claimed
    for (const word of ["improv", "better", "worse", "p_value", "pvalue", "significan"]) assert.ok(!text.includes(word), `summary contains "${word}"`);
    assert.match(summary.label, /single Troy training house/);
  });

  test("distributions ignore missing values but keep the denominator", () => {
    assert.deepEqual(distribution([3, null, 1, 2], 4), { available: 3, of: 4, median: 2, min: 1, max: 3 });
    assert.deepEqual(distribution([null], 1), { available: 0, of: 1, median: null, min: null, max: null });
  });
});
