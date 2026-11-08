/**
 * Evaluator outcomes. Only the independent evaluator reads hidden simulation truth; everything here is
 * labelled as simulation evidence and never flows back into planning, motion control or the harness.
 * A detection is not an evacuation, and a safe abort is a safety outcome, not a completed rescue.
 */
import type { Tick } from "./clock.ts";
import type { RunId } from "./ids.ts";

/** "outside_not_at_assembly_point": left the building but has not reached the assembly point (not a completed rescue). */
export type OccupantOutcome = "reached_assembly_point" | "outside_not_at_assembly_point" | "inside" | "incapacitated";

export interface EvaluatorOccupantResult {
  readonly label: "simulation_evaluator";
  /** Evaluator-private key; never shown to planners or used as a track id. */
  readonly occupantKey: string;
  readonly outcome: OccupantOutcome;
  readonly arrivalTick: Tick | null;
}

/**
 * Drone return, reported separately from the rescue outcome:
 * - "returned": in the launch zone at the end after a recorded departure from it;
 * - "no_departure_recorded": in the launch zone, but no departure from it was recorded (it never left, or
 *   no trace was kept), so nothing has returned;
 * - "landed_contingency": touched down outside the launch zone;
 * - "forced_descent": endurance ran out and the aircraft made the uncommanded descent (not a landing);
 * - "failed_no_supported_maneuver": the run recorded that no supported maneuver remained (the harness's
 *   brake-and-descend is not a landing);
 * - "not_returned": anything else (still airborne away from the launch zone).
 */
export type DroneReturnResult = "returned" | "no_departure_recorded" | "landed_contingency" | "forced_descent" | "failed_no_supported_maneuver" | "not_returned";

export interface ConstraintViolation {
  readonly tick: Tick;
  readonly kind: "collision" | "hazardous_discharge" | "unauthorized_actuation" | "envelope_breach" | "hard_limit";
  readonly detail: string;
}

export interface MissionResult {
  readonly label: "simulation_evaluator";
  readonly runId: RunId;
  readonly seed: string;
  readonly endedTick: Tick;
  /** Rescue budget on the mission clock. */
  readonly budgetTick: Tick;
  readonly occupants: readonly EvaluatorOccupantResult[];
  readonly violations: readonly ConstraintViolation[];
  readonly droneReturn: DroneReturnResult;
}

/**
 * PRD primary metric: the modeled occupants reach the exterior assembly point within budget, with no drone
 * collision and no independently scored constraint violation. EVERY occupant the evaluator knows must have
 * arrived within budget: anyone still inside, outside but not at the assembly point, incapacitated or late
 * leaves the evacuation incomplete (human assistance needed). A run with no modeled occupant is not a
 * completed rescue. Drone return is reported separately.
 */
export function isCompletedRescue(result: MissionResult): boolean {
  return result.violations.length === 0
    && result.occupants.length > 0
    && result.occupants.every(o => o.outcome === "reached_assembly_point" && o.arrivalTick !== null && o.arrivalTick <= result.budgetTick);
}

export type RescueLabel = "simulated_evacuation_completed" | "incomplete_human_assistance_needed";

/** The only wording command may use for a rescue outcome. */
export function rescueLabel(result: MissionResult): RescueLabel {
  return isCompletedRescue(result) ? "simulated_evacuation_completed" : "incomplete_human_assistance_needed";
}
