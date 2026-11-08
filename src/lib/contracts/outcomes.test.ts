import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EvaluatorOccupantResult, MissionResult, OccupantOutcome } from "./outcomes.ts";
import { isCompletedRescue, rescueLabel } from "./outcomes.ts";

const occupant = (key: string, outcome: OccupantOutcome, arrivalTick: number | null = null): EvaluatorOccupantResult => ({ label: "simulation_evaluator", occupantKey: key, outcome, arrivalTick });
const result = (occupants: EvaluatorOccupantResult[]): MissionResult => ({ label: "simulation_evaluator", runId: "run-1", seed: "s", endedTick: 9000, budgetTick: 8000, occupants, violations: [], droneReturn: "not_returned" });

describe("completed rescue: every occupant the evaluator knows", () => {
  test("one arrival is not a completed evacuation while anyone else is inside, outside short of the assembly point or incapacitated", () => {
    const arrived = occupant("a", "reached_assembly_point", 7000);
    assert.equal(rescueLabel(result([arrived])), "simulated_evacuation_completed");
    assert.equal(rescueLabel(result([arrived, occupant("b", "reached_assembly_point", 7900)])), "simulated_evacuation_completed");
    for (const other of ["inside", "outside_not_at_assembly_point", "incapacitated"] as const) {
      assert.equal(isCompletedRescue(result([arrived, occupant("b", other)])), false, other);
      assert.equal(rescueLabel(result([occupant("b", other), arrived])), "incomplete_human_assistance_needed", `${other}, listed first`);
    }
  });

  test("every arrival must be within budget, and a run with no modeled occupant is not a rescue", () => {
    assert.equal(isCompletedRescue(result([occupant("a", "reached_assembly_point", 7000), occupant("b", "reached_assembly_point", 8001)])), false);
    assert.equal(isCompletedRescue(result([])), false);
  });
});
