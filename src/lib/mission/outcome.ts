/**
 * Evaluator-side run control: when a run is over and what it achieved. This is the only part of the runtime
 * that reads occupant truth, and only to score the run and to stop stepping once nothing more can happen;
 * nothing here reaches the planner, the harness, the evidence store or the controller.
 *
 * A run ends at the rescue budget, or once the aircraft has settled (back and still in the launch zone, or
 * touched down after flying) and either every occupant is terminal (at the assembly point or incapacitated)
 * or the mission can no longer act (aborted, terminal failure). An occupant's arrival is announced on the
 * timeline as labelled simulation evidence when it happens.
 */
import type { Tick } from "../contracts/clock.ts";
import type { EventLog } from "../contracts/events.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import { norm } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import { regionContains } from "../contracts/geometry.ts";
import type { MissionResult } from "../contracts/outcomes.ts";
import { rescueLabel } from "../contracts/outcomes.ts";
import { evaluateMission } from "../evaluation/evaluate.ts";
import type { MissionTrace } from "../evaluation/trace.ts";
import { isTouchedDown } from "../simulation/collisions.ts";
import type { WorldState } from "../simulation/world-state.ts";

const FLOWN_ALTITUDE_M = 1;
const SETTLED_SPEED_MPS = 0.2;

export interface RunState {
  readonly budgetTick: Tick;
  readonly launchZone: Region;
  readonly missionAborted: boolean;
  readonly terminalFailure: boolean;
  /** An executing motion action still owns the aircraft. */
  readonly motionExecuting: boolean;
}

export class RunWatch {
  private flown = false;
  private readonly announced = new Set<string>();

  /** Log each occupant's arrival once, as simulation evidence (evaluator source). */
  announce(world: WorldState, log: EventLog, tick: Tick): void {
    if (world.drone.position.z > FLOWN_ALTITUDE_M) this.flown = true;
    for (const occupant of world.occupants) {
      if (occupant.arrivalTick === null || this.announced.has(occupant.key)) continue;
      this.announced.add(occupant.key);
      log.append({ tick, source: "evaluator", kind: "evaluator.occupant_arrived", subject: null, reason: "Simulated occupant reached assembly point (simulation evaluator evidence; other rooms remain unresolved).", data: { label: "simulation_evaluator", arrivalTick: occupant.arrivalTick } });
    }
  }

  get anyArrived(): boolean {
    return this.announced.size > 0;
  }

  /** True when the run should stop stepping. */
  over(world: WorldState, state: RunState): boolean {
    if (world.tick >= state.budgetTick) return true;
    if (!this.settled(world, state)) return false;
    const occupantsDone = world.occupants.every(o => o.arrivalTick !== null || o.activity === "incapacitated");
    return occupantsDone || state.missionAborted || state.terminalFailure;
  }

  private settled(world: WorldState, state: RunState): boolean {
    if (!this.flown) return false;
    const still = norm(world.drone.velocity) < SETTLED_SPEED_MPS;
    if (isTouchedDown(world)) return true;
    return still && !state.motionExecuting && regionContains(state.launchZone, world.drone.position);
  }
}

/** Score the run with the independent evaluator and append the outcome event. */
export function scoreRun(world: WorldState, envelope: MissionEnvelope, state: RunState, trace: MissionTrace, log: EventLog, tick: Tick): MissionResult {
  const result = evaluateMission(world, envelope, state.budgetTick, state.launchZone, { trace, failureRecorded: state.terminalFailure });
  const label = rescueLabel(result);
  const wording = label === "simulated_evacuation_completed" ? "Simulated evacuation completed: the occupant reached the assembly point within budget without a scored violation." : "Incomplete: human assistance needed (no evaluator-verified evacuation within budget without violations).";
  log.append({
    tick, source: "evaluator", kind: "outcome.recorded", subject: null,
    reason: `${wording} Drone return: ${result.droneReturn}. ${result.violations.length} violation(s).`,
    data: { label: "simulation_evaluator", rescueLabel: label, droneReturn: result.droneReturn, violations: result.violations.length, occupants: result.occupants.map(o => o.outcome) },
  });
  return result;
}
