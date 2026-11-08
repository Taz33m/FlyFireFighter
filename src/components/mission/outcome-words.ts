/**
 * Display words for evaluator outcomes, shared by every surface that shows one: the live rescue record, the
 * presenter view, the results page and the recorded replay.
 *
 * The rescue wording is chosen ONLY from rescueLabel(result) (contracts/outcomes.ts): no surface decides
 * completion itself. A run without a usable evaluator result reads as incomplete on the results page, and as
 * "Exterior arrival not confirmed" while a live run or replay has not reached its outcome yet. Pure and
 * browser-safe (relative .ts imports, so `node --test` runs it directly).
 */
import type { DroneReturnResult, MissionResult, OccupantOutcome, RescueLabel } from "../../lib/contracts/outcomes.ts";
import { rescueLabel } from "../../lib/contracts/outcomes.ts";

export const RESCUE_WORDS = {
  simulated_evacuation_completed: "Simulated evacuation completed",
  incomplete_human_assistance_needed: "Incomplete: human assistance needed",
} as const satisfies Readonly<Record<RescueLabel, string>>;

export type RescueWords = (typeof RESCUE_WORDS)[RescueLabel];

/** Before the evaluator's outcome exists (live, or a replay whose playhead has not reached it). */
export const PENDING_OUTCOME_WORDS = "Exterior arrival not confirmed";

export function rescueWords(label: RescueLabel): RescueWords {
  return RESCUE_WORDS[label];
}

/** The rescue words for an evaluator result; an unscored run (null) is incomplete, never completed. */
export function outcomeWords(result: MissionResult | null): RescueWords {
  return result === null ? RESCUE_WORDS.incomplete_human_assistance_needed : rescueWords(rescueLabel(result));
}

export const OCCUPANT_OUTCOME_WORDS: Readonly<Record<OccupantOutcome, string>> = {
  reached_assembly_point: "reached the assembly point",
  outside_not_at_assembly_point: "outside, not at the assembly point",
  inside: "still inside",
  incapacitated: "incapacitated",
};

/** Every drone-return value, worded. Its keys are also the list of known values when validating a stored result. */
export const DRONE_RETURN_WORDS: Readonly<Record<DroneReturnResult, string>> = {
  returned: "Drone returned",
  no_departure_recorded: "Drone never left the launch zone (no departure recorded)",
  landed_contingency: "Drone landed (contingency)",
  forced_descent: "Drone forced descent (endurance exhausted)",
  failed_no_supported_maneuver: "Drone failed: no supported maneuver",
  not_returned: "Drone did not return",
};
