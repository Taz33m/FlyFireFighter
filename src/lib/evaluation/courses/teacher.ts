/**
 * Truth-based course teacher (training labels and evaluator reference only).
 *
 * It plans on the TRUE active colliders (planner.ts) and the TRUE aircraft pose, then issues the command a
 * careful pilot would: yaw toward a look-ahead point on the cost-to-go descent, slow down as the heading
 * error grows (turn in place beyond ~70°), brake against the true free distance along the current heading
 * and slow on the final approach. Architecture §3 allows a teacher to use world truth to LABEL training
 * data; the deployed trained readout never receives any of it. The evaluator also uses the teacher's view
 * to define false braking (stopped while facing a clear planned path).
 */
import { TENDER_T1 } from "../../contracts/aircraft.ts";
import { wrapAngle } from "../../contracts/frames.ts";
import type { WorldState } from "../../simulation/world-state.ts";
import { activeColliders } from "../../simulation/world-state.ts";
import type { CourseSpec } from "./course.ts";
import { boxesInBand, lookaheadPoint, PlanGrid } from "./planner.ts";

export interface TeacherConfig {
  readonly cruiseMps: number;
  readonly lookaheadM: number;
  readonly yawGain: number;
  readonly maxYawRateRadps: number;
  /** Gap kept to the first obstacle along the heading (beyond the aircraft radius), m. */
  readonly stopGapM: number;
  readonly brakeTimeS: number;
  readonly approachGain: number;
  /** Heading error beyond which the teacher turns in place. */
  readonly turnInPlaceRad: number;
}

export const DEFAULT_TEACHER: TeacherConfig = Object.freeze({ cruiseMps: 1.2, lookaheadM: 0.9, yawGain: 2.0, maxYawRateRadps: 1.2, stopGapM: 0.3, brakeTimeS: 0.9, approachGain: 0.8, turnInPlaceRad: 1.2 });

export interface TeacherCommand {
  readonly forwardMps: number;
  readonly yawRateRadps: number;
  /** Heading error to the planned look-ahead direction, rad (positive: plan is to the left). */
  readonly headingErrorRad: number;
  /** True free distance along the current heading before the aircraft would touch an obstacle, m. */
  readonly freeAheadM: number;
  /** True gap between the aircraft's sphere and the nearest obstacle in the flight band, m. */
  readonly gapM: number;
  /** Remaining planned path length to the goal, m (Infinity when unreachable). */
  readonly remainingM: number;
}

const clamp = (value: number, lo: number, hi: number): number => (value < lo ? lo : value > hi ? hi : value);

export class CourseTeacher {
  readonly config: TeacherConfig;
  private readonly spec: CourseSpec;
  private readonly radiusM = TENDER_T1.spanM / 2;
  private grid: PlanGrid | null = null;
  private colliderCount = -1;

  constructor(spec: CourseSpec, config: TeacherConfig = DEFAULT_TEACHER) {
    this.spec = spec;
    this.config = config;
  }

  /** Rebuild the plan when the active collider set changed (debris fell). */
  private planFor(world: WorldState): PlanGrid {
    if (this.grid === null || world.activeColliderIds.size !== this.colliderCount) {
      const margin = 0.05;
      this.grid = new PlanGrid(this.spec.interior, boxesInBand(activeColliders(world), this.spec.goal.z, this.radiusM + margin));
      this.colliderCount = world.activeColliderIds.size;
    }
    return this.grid;
  }

  command(world: WorldState): TeacherCommand {
    const c = this.config;
    const grid = this.planFor(world);
    const { x, y } = world.drone.position;
    const yaw = world.drone.yawRad;
    const gap = grid.clearanceAt(x, y) - this.radiusM;
    const freeAhead = this.freeAlong(grid, x, y, yaw);
    const goal = this.spec.goal;
    const goalDistance = Math.hypot(goal.x - x, goal.y - y);
    const field = grid.field(goal.x, goal.y);
    const target = goalDistance < c.lookaheadM ? { x: goal.x, y: goal.y, remainingM: 0 } : lookaheadPoint(grid, field, x, y, c.lookaheadM);
    if (target === null) return { forwardMps: 0, yawRateRadps: 0, headingErrorRad: 0, freeAheadM: freeAhead, gapM: gap, remainingM: Infinity };
    const error = Math.hypot(target.x - x, target.y - y) < 0.05 ? 0 : wrapAngle(Math.atan2(target.y - y, target.x - x) - yaw);
    const yawRate = clamp(c.yawGain * error, -c.maxYawRateRadps, c.maxYawRateRadps);
    const remaining = target.remainingM + Math.hypot(target.x - x, target.y - y);
    const align = Math.abs(error) >= c.turnInPlaceRad ? 0 : Math.cos((Math.abs(error) / c.turnInPlaceRad) * (Math.PI / 2));
    const brake = Math.max(0, (freeAhead - c.stopGapM) / c.brakeTimeS);
    const approach = c.approachGain * goalDistance;
    const forward = Math.max(0, Math.min(c.cruiseMps * align, brake, approach));
    return { forwardMps: forward, yawRateRadps: yawRate, headingErrorRad: error, freeAheadM: freeAhead, gapM: gap, remainingM: remaining };
  }

  /** Distance the aircraft can travel along `heading` before its sphere touches an obstacle (≤ 6 m). */
  private freeAlong(grid: PlanGrid, x: number, y: number, heading: number): number {
    const dx = Math.cos(heading);
    const dy = Math.sin(heading);
    const step = 0.05;
    for (let s = 0; s <= 6; s += step) {
      if (grid.clearanceAt(x + dx * s, y + dy * s) < this.radiusM) return Math.max(0, s - step);
    }
    return 6;
  }
}
