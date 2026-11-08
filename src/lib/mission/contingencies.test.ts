import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SCOUT_S1, TENDER_T1 } from "../contracts/aircraft.ts";
import type { AircraftProfile } from "../contracts/aircraft.ts";
import { AMBIENT_MARGIN_C, ambientWithdrawal, EXPOSURE_WITHDRAW_FRACTION } from "./contingencies.ts";
import type { PlannerTick } from "./planner-step.ts";

/** Only the fields ambientWithdrawal reads: the aircraft's own ambient reading, its profile and the envelope ceiling. */
function tickWith(ambientC: number | null, profile: AircraftProfile = TENDER_T1, ambientCeilingC = 80): PlannerTick {
  return { ctx: { belief: { aircraft: { ambientC } }, profile, envelope: { ambientCeilingC } } } as unknown as PlannerTick;
}

describe("withdrawing from heat", () => {
  const limits = TENDER_T1.hardLimits;

  test("withdraws within the margin of the lower of the aircraft limit and the envelope ceiling", () => {
    const limitC = Math.min(limits.maxAmbientC, 80);
    assert.equal(ambientWithdrawal(tickWith(limitC - AMBIENT_MARGIN_C - 0.1), 0), false);
    assert.equal(ambientWithdrawal(tickWith(limitC - AMBIENT_MARGIN_C), 0), true);
    // A stricter envelope ceiling governs; so does a lower aircraft limit (the scout's 70 °C).
    assert.equal(ambientWithdrawal(tickWith(66, TENDER_T1, 70), 0), true);
    assert.equal(ambientWithdrawal(tickWith(66, SCOUT_S1, 80), 0), true);
    assert.equal(ambientWithdrawal(tickWith(66, TENDER_T1, 80), 0), false);
  });

  test("withdraws once most of the exposure budget above the warning temperature is spent, even below the limit", () => {
    const budgetS = EXPOSURE_WITHDRAW_FRACTION * limits.maxExposureAboveWarnS;
    assert.ok(budgetS < limits.maxExposureAboveWarnS, "before the evaluator's limit is reached");
    assert.equal(ambientWithdrawal(tickWith(limits.warnAmbientC + 1), budgetS - 0.01), false);
    assert.equal(ambientWithdrawal(tickWith(limits.warnAmbientC + 1), budgetS), true);
  });

  test("an unknown reading withdraws only on the exposure already recorded", () => {
    assert.equal(ambientWithdrawal(tickWith(null), 0), false);
    assert.equal(ambientWithdrawal(tickWith(null), limits.maxExposureAboveWarnS), true);
  });
});
