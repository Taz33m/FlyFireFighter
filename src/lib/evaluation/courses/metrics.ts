/**
 * Evaluator metrics for one course run, from simulator truth (never fed back to a controller).
 *
 * - collisions: truth "collision" events (debounced by the simulator), with ticks;
 * - completed: the harness's move completed (estimated arrival) AND the true position is within
 *   COMPLETE_RADIUS_M of the goal, inside the time budget; time to goal is reported only then;
 * - false braking: time with true horizontal speed < SLOW_MPS while the truth teacher would fly at ≥
 *   TEACHER_GO_MPS and the aircraft already faces the planned path (|heading error| < FACING_RAD), after
 *   the first second — i.e. stopped or crawling with a clear path ahead;
 * - obstacle completion: planned-path progress (1 − best remaining truth-planner path / initial path), whether
 *   the aircraft passed the narrow doorway and (when present) the fallen debris, in corridor coordinates;
 * - min gap: smallest true distance between the aircraft's sphere and an obstacle in the flight band;
 * - neural deadlines: FlyVis round trips over one visual frame (20 ms) and over the client's default
 *   50 ms step deadline (the batch runner waits instead of falling back, so these are counted, not acted on);
 * - controller compute time per visual step (all controllers, against the same 20 ms budget).
 * A run ends at completion, budget, or a stall (no 0.3 m of progress toward the goal for stallS seconds;
 * counted as incomplete — stopping forever cannot win).
 */
import type { MotionLimit, ProposalStatus } from "../../contracts/actions.ts";
import { TICK_S } from "../../contracts/clock.ts";
import type { MotionController } from "../../navigation/reflex/types.ts";
import type { WorldState } from "../../simulation/world-state.ts";
import type { CourseSpec } from "./course.ts";
import { toLocal } from "./course.ts";
import type { TeacherCommand } from "./teacher.ts";

export const METRIC_THRESHOLDS = Object.freeze({ COMPLETE_RADIUS_M: 0.6, SLOW_MPS: 0.25, TEACHER_GO_MPS: 0.6, FACING_RAD: 0.5, WARMUP_S: 1.0, FRAME_BUDGET_MS: 20, CLIENT_DEADLINE_MS: 50 });

export type EndReason = "completed" | "budget" | "stall" | "arrived_estimate_only" | "harness_stopped";

export interface Timing {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly over20Ms: number;
  readonly over50Ms: number;
}

export interface RunMetrics {
  readonly courseId: string;
  readonly split: string;
  readonly runId: string;
  readonly controllerId: string | null;
  readonly controllerSource: string | null;
  readonly driver: string;
  readonly rangeAssist: boolean;
  readonly endReason: EndReason;
  readonly completed: boolean;
  readonly timeToGoalS: number | null;
  readonly durationS: number;
  readonly collisions: number;
  readonly collisionTicks: readonly number[];
  readonly falseBrakingS: number;
  readonly minGapM: number;
  readonly progress: number;
  readonly doorwayPassed: boolean;
  readonly debrisPassed: boolean | null;
  readonly finalDistanceM: number;
  readonly pathLengthM: number;
  readonly debrisTick: number | null;
  readonly neural: Timing | null;
  readonly controllerTiming: Timing;
  readonly renderTiming: Timing;
  readonly modes: Readonly<Record<string, number>>;
  readonly harnessLimits: Readonly<Record<string, number>>;
}

export function timing(values: readonly number[]): Timing {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]);
  return {
    count: sorted.length, p50Ms: round(at(0.5)), p95Ms: round(at(0.95)), maxMs: round(sorted[sorted.length - 1] ?? 0),
    over20Ms: sorted.filter(v => v > METRIC_THRESHOLDS.FRAME_BUDGET_MS).length, over50Ms: sorted.filter(v => v > METRIC_THRESHOLDS.CLIENT_DEADLINE_MS).length,
  };
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

export class MetricsRecorder {
  private readonly spec: CourseSpec;
  private readonly runId: string;
  private readonly info: { controller: MotionController | null; neural: boolean; rangeAssist: boolean; driver: string };
  private readonly renderMs: number[] = [];
  private readonly neuralMs: number[] = [];
  private readonly controllerMs: number[] = [];
  private readonly modes: Record<string, number> = {};
  private readonly limits: Record<string, number> = {};
  private falseBrakingS = 0;
  private minGap = Infinity;
  private path = 0;
  private last: { x: number; y: number } | null = null;
  private best = Infinity;
  private bestTick = 0;
  private debrisTick: number | null = null;
  private initialRemaining: number | null = null;
  private bestRemaining = Infinity;
  private maxU = -Infinity;

  constructor(spec: CourseSpec, runId: string, info: { controller: MotionController | null; neural: boolean; rangeAssist: boolean; driver: string }) {
    this.spec = spec;
    this.runId = runId;
    this.info = info;
  }

  render(ms: number): void {
    this.renderMs.push(ms);
  }

  neural(ms: number): void {
    this.neuralMs.push(ms);
  }

  controller(ms: number, label: string): void {
    this.controllerMs.push(ms);
    const mode = label.split("/")[1] ?? label;
    this.modes[mode] = (this.modes[mode] ?? 0) + 1;
  }

  limit(limit: MotionLimit): void {
    this.limits[limit] = (this.limits[limit] ?? 0) + 1;
  }

  debris(tick: number): void {
    this.debrisTick = tick;
  }

  /** Once per visual tick, with the truth teacher's view of the current state. */
  visual(world: WorldState, label: TeacherCommand): void {
    const t = METRIC_THRESHOLDS;
    this.minGap = Math.min(this.minGap, label.gapM);
    if (Number.isFinite(label.remainingM)) {
      this.initialRemaining ??= label.remainingM;
      this.bestRemaining = Math.min(this.bestRemaining, label.remainingM);
    }
    const speed = Math.hypot(world.drone.velocity.x, world.drone.velocity.y);
    const elapsed = world.tick * TICK_S;
    const goalDistance = this.distance(world);
    if (elapsed >= t.WARMUP_S && goalDistance > t.COMPLETE_RADIUS_M && speed < t.SLOW_MPS && label.forwardMps >= t.TEACHER_GO_MPS && Math.abs(label.headingErrorRad) < t.FACING_RAD) {
      this.falseBrakingS += 2 * TICK_S;
    }
  }

  tick(world: WorldState): void {
    const { x, y } = world.drone.position;
    if (this.last) this.path += Math.hypot(x - this.last.x, y - this.last.y);
    this.last = { x, y };
    this.maxU = Math.max(this.maxU, toLocal(this.spec, x, y)[0]);
    const d = this.distance(world);
    if (d < this.best - 0.3) {
      this.best = d;
      this.bestTick = world.tick;
    }
  }

  private distance(world: WorldState): number {
    return Math.hypot(world.drone.position.x - this.spec.goal.x, world.drone.position.y - this.spec.goal.y);
  }

  endReason(world: WorldState, moveStatus: ProposalStatus | null, budgetTicks: number, stallS: number): EndReason | null {
    if (moveStatus === "rejected" || moveStatus === "expired" || moveStatus === "invalidated" || moveStatus === "aborted") return "harness_stopped";
    if (moveStatus === "completed") return this.distance(world) <= METRIC_THRESHOLDS.COMPLETE_RADIUS_M ? "completed" : "arrived_estimate_only";
    if (world.tick >= budgetTicks) return "budget";
    if ((world.tick - this.bestTick) * TICK_S >= stallS) return "stall";
    return null;
  }

  private progressFraction(completed: boolean): number {
    if (completed) return 1;
    if (this.initialRemaining === null || !(this.initialRemaining > 0) || !Number.isFinite(this.bestRemaining)) return 0;
    return Math.min(1, Math.max(0, 1 - this.bestRemaining / this.initialRemaining));
  }

  finish(world: WorldState, end: EndReason): RunMetrics {
    const collisions = world.truthEvents.filter(e => e.kind === "collision");
    const completed = end === "completed";
    const c = this.info.controller;
    return {
      courseId: this.spec.courseId, split: this.spec.split, runId: this.runId, controllerId: c?.id ?? null, controllerSource: c?.source ?? null,
      driver: this.info.driver, rangeAssist: this.info.rangeAssist, endReason: end, completed,
      timeToGoalS: completed ? round(world.tick * TICK_S) : null, durationS: round(world.tick * TICK_S),
      collisions: collisions.length, collisionTicks: collisions.map(e => e.tick), falseBrakingS: round(this.falseBrakingS),
      minGapM: round(Number.isFinite(this.minGap) ? this.minGap : -1), progress: round(this.progressFraction(completed)),
      doorwayPassed: this.maxU > this.spec.layout.doorway.u + this.spec.layout.doorway.thicknessM + 0.3,
      debrisPassed: this.spec.layout.debris ? this.maxU > this.spec.layout.debris.box.max[0] + 0.3 : null, finalDistanceM: round(this.distance(world)), pathLengthM: round(this.path), debrisTick: this.debrisTick,
      neural: this.info.neural ? timing(this.neuralMs) : null, controllerTiming: timing(this.controllerMs), renderTiming: timing(this.renderMs),
      modes: { ...this.modes }, harnessLimits: { ...this.limits },
    };
  }
}
