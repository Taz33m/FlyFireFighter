/**
 * Paired conditions for the seeded mission evaluation (PRD §8, architecture §8).
 *
 * Every condition runs the Troy scene headless with the collider camera, the LOCAL planner (never cloud
 * decisions in batch), the bounded scripted commander (DEFAULT_SCRIPTED_COMMANDER, recall on evaluator
 * arrival) and the preset budget. A condition differs from its pair partner only in the one stated factor:
 * controller, preset variant, range assistance, or an injected failure. Seeds are shared across conditions,
 * and the simulator's noise is keyed by (seed, stream, tick), so two conditions on the same seed start from
 * the same world and the same observation-noise streams; trajectories then diverge naturally.
 *
 * Some conditions need something that may be absent: the FlyVis service (engineered readout) or a runtime
 * option (range assistance off, a reduced initial water load). Those are recorded as NOT RUN with the
 * reason; nothing is substituted.
 */
import type { PresetVariant } from "../../mission/scenario.ts";
import type { ControllerMode } from "../../mission/protocol.ts";

export type InjectionKind = "stale_evidence" | "localization_loss" | "payload_exhaustion" | "blocked_return";

/** What a condition needs beyond the always-available headless runtime. */
export type Requirement = "flyvis_service" | "runtime_range_assist_option" | "runtime_initial_water_option";

export interface Condition {
  readonly id: string;
  readonly controller: ControllerMode;
  readonly variant: PresetVariant;
  /** False only for the "fly-model motion alone" arm of the range-assistance pair. */
  readonly rangeAssist: boolean;
  readonly injection: InjectionKind | null;
  readonly requires: readonly Requirement[];
  /** The condition this one is paired against, and the single factor that differs. */
  readonly pair: { readonly against: string; readonly factor: string } | null;
  /** Expectation stated before running (checked in the report, never used to score). */
  readonly expectation: string;
}

export const BASELINE_ID = "main.flow";

export const CONDITIONS: readonly Condition[] = [
  { id: BASELINE_ID, controller: "flow_baseline", variant: "main", rangeAssist: true, injection: null, requires: [], pair: null, expectation: "Reference arm: normal execution with the optical-flow baseline." },
  { id: "main.readout", controller: "engineered_readout", variant: "main", rangeAssist: true, injection: null, requires: ["flyvis_service"], pair: { against: BASELINE_ID, factor: "controller: optical-flow baseline vs FlyVis engineered readout" }, expectation: "Same mission with actual FlyVis features; no directional expectation is stated." },
  { id: "main.flow.no_range", controller: "flow_baseline", variant: "main", rangeAssist: false, injection: null, requires: ["runtime_range_assist_option"], pair: { against: BASELINE_ID, factor: "range assistance: with vs without" }, expectation: "Motion without range assistance; more braking from vision only." },
  { id: "immobile.flow", controller: "flow_baseline", variant: "immobile_occupant", rangeAssist: true, injection: null, requires: [], pair: { against: BASELINE_ID, factor: "variant: immobile occupant" }, expectation: "Incomplete rescue (human assistance needed): the occupant cannot walk." },
  { id: "blocked_exit.flow", controller: "flow_baseline", variant: "blocked_exit", rangeAssist: true, injection: null, requires: [], pair: { against: BASELINE_ID, factor: "variant: front exit jammed in the world, drawn closed in the plan" }, expectation: "Incomplete rescue: the only exit is jammed." },
  { id: "wrong_prior.flow", controller: "flow_baseline", variant: "wrong_prior", rangeAssist: true, injection: null, requires: [], pair: { against: BASELINE_ID, factor: "variant: open interior door drawn closed in the prior" }, expectation: "Rescue possible once sensing corrects the prior; no fixed expectation." },
  { id: "inject.stale_evidence", controller: "flow_baseline", variant: "main", rangeAssist: true, injection: "stale_evidence", requires: [], pair: { against: BASELINE_ID, factor: "injected: a person steps into the pending spray region (judge challenge)" }, expectation: "The harness refuses or invalidates the pending spray once the person is sensed; no hazardous discharge." },
  { id: "inject.localization_loss", controller: "flow_baseline", variant: "main", rangeAssist: true, injection: "localization_loss", requires: [], pair: { against: BASELINE_ID, factor: "injected: localization loss (sigma +3 m at tick 1200)" }, expectation: "Advancement stops; a localization contingency is selected; incomplete rescue." },
  { id: "inject.payload_exhaustion", controller: "flow_baseline", variant: "main", rangeAssist: true, injection: "payload_exhaustion", requires: ["runtime_initial_water_option"], pair: { against: BASELINE_ID, factor: "injected: too little water for the suppression" }, expectation: "Spray refused or insufficient; no route reassessment success; incomplete rescue." },
  { id: "inject.blocked_return", controller: "flow_baseline", variant: "main", rangeAssist: true, injection: "blocked_return", requires: [], pair: { against: BASELINE_ID, factor: "injected: the aircraft's openings to the exterior are obstructed at evaluator arrival" }, expectation: "Rescue outcome unchanged if the occupant already arrived; return replaced by a contingency when the aircraft is still inside." },
];

export function conditionById(id: string): Condition {
  const condition = CONDITIONS.find(c => c.id === id);
  if (!condition) throw new RangeError(`Unknown condition "${id}". Known: ${CONDITIONS.map(c => c.id).join(", ")}`);
  return condition;
}

export interface RunSpec {
  readonly runId: string;
  readonly seed: string;
  readonly condition: Condition;
}

/** Seeds "eval-seed-1" … "eval-seed-n". */
export function seedList(count: number, prefix = "eval-seed"): string[] {
  if (!Number.isInteger(count) || count < 1) throw new RangeError("Seed count must be a positive integer");
  return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
}

/** Run id for one (condition, seed): short (≤ 64 characters, the FlyVis run-id limit) and filesystem-safe. */
export function runIdFor(conditionId: string, seed: string): string {
  const id = `ev-${conditionId}-${seed}`.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (id.length > 64) throw new RangeError(`Run id too long: ${id}`);
  return id;
}

/** Every seed × condition, seed-major, with unique run ids so no bundle or result can be overwritten. */
export function planRuns(seeds: readonly string[], conditionIds: readonly string[]): RunSpec[] {
  const conditions = conditionIds.map(conditionById);
  if (new Set(seeds).size !== seeds.length) throw new RangeError("Seeds must be distinct");
  if (new Set(conditionIds).size !== conditionIds.length) throw new RangeError("Conditions must be distinct");
  const runs = seeds.flatMap(seed => conditions.map(condition => ({ runId: runIdFor(condition.id, seed), seed, condition })));
  const ids = new Set<string>();
  for (const run of runs) {
    if (ids.has(run.runId)) throw new RangeError(`Run id collision after sanitizing seeds: ${run.runId}`);
    ids.add(run.runId);
  }
  return runs;
}
