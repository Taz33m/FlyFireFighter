/**
 * Shared outcome wording: every surface (live rescue record, results page, replay) takes the rescue words
 * from rescueLabel through this table, so a result the evaluator scores incomplete can never read as a
 * completed evacuation on any of them, and the two spellings that used to differ cannot drift apart again.
 * Scope: the pure word tables and functions; the components that render them are checked in the browser.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MissionResult } from "../../lib/contracts/outcomes.ts";
import { isCompletedRescue } from "../../lib/contracts/outcomes.ts";
import { DRONE_RETURN_WORDS, outcomeWords, PENDING_OUTCOME_WORDS, RESCUE_WORDS } from "./outcome-words.ts";

function result(overrides: Partial<MissionResult> = {}): MissionResult {
  return {
    label: "simulation_evaluator", runId: "run-w", seed: "s", endedTick: 9000, budgetTick: 12000,
    occupants: [{ label: "simulation_evaluator", occupantKey: "o-1", outcome: "reached_assembly_point", arrivalTick: 8000 }],
    violations: [], droneReturn: "returned", ...overrides,
  };
}

describe("rescue words", () => {
  test("the completed words appear only for a result isCompletedRescue accepts", () => {
    const cases: MissionResult[] = [
      result(),
      result({ violations: [{ tick: 10, kind: "collision", detail: "wall" }] }),
      result({ occupants: [{ label: "simulation_evaluator", occupantKey: "o", outcome: "reached_assembly_point", arrivalTick: 12001 }] }),
      result({ occupants: [{ label: "simulation_evaluator", occupantKey: "o", outcome: "outside_not_at_assembly_point", arrivalTick: null }] }),
      result({ occupants: [] }),
    ];
    for (const r of cases) {
      assert.equal(outcomeWords(r) === RESCUE_WORDS.simulated_evacuation_completed, isCompletedRescue(r), JSON.stringify(r.occupants));
    }
  });

  test("an unscored run reads incomplete, and the pending words claim neither outcome", () => {
    assert.equal(outcomeWords(null), "Incomplete: human assistance needed");
    assert.doesNotMatch(PENDING_OUTCOME_WORDS, /completed|incomplete/i);
  });

  test("the two rescue labels have distinct words with one spelling", () => {
    assert.deepEqual(Object.values(RESCUE_WORDS), ["Simulated evacuation completed", "Incomplete: human assistance needed"]);
  });

  test("every drone-return value has its own words, separate from the rescue outcome", () => {
    const values = Object.keys(DRONE_RETURN_WORDS);
    assert.ok(values.includes("no_departure_recorded") && values.includes("forced_descent"));
    assert.equal(new Set(Object.values(DRONE_RETURN_WORDS)).size, values.length);
    assert.ok(Object.values(DRONE_RETURN_WORDS).every(w => !/evacuation/i.test(w)));
  });
});
