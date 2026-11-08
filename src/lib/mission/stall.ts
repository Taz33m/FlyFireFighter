/**
 * Stale looming memory: the supervisory re-sense of the motion controller.
 *
 * The shared reflex mapper keeps a metric free distance from looming and, by design, holds it while the
 * aircraft hovers in front of a measured surface (no motion means no new looming measurement). A spurious
 * near reading (for example expansion-like flow during a combined forward and vertical maneuver) therefore
 * becomes a permanent stop: the ceiling (free − stopDistance)/brakeTime is zero, so the aircraft never moves
 * again to measure. This monitor detects exactly that state from the controller's own reported features and
 * the efference copy: hovering, the goal ahead and beyond arrival, the looming free distance at the stop
 * distance, and the forward range reading (when there is one) farther than that free distance plus a margin.
 * After STALL.ticks of it the runtime resets the controller's temporal state, so it re-senses from its clear
 * prior at exploration speed: a real obstacle is measured again within a few frames and stops it again;
 * range assistance stays active throughout. Resets are rate limited.
 */
import type { ControllerInput } from "../navigation/reflex/types.ts";

export const STALL = Object.freeze({
  ticks: 200,
  minRepeatTicks: 300,
  hoverSpeedMps: 0.05,
  aheadRad: 0.6,
  /** Free distance at or below stopDistance + this counts as "held at the stop distance". */
  freeMarginM: 0.25,
  /** A forward range reading must exceed the free distance by this much to contradict it. */
  rangeMarginM: 0.5,
});

export class StallMonitor {
  private since: number | null = null;
  private lastReset = -Infinity;
  resets = 0;

  /** Feed one controller step; returns a reason when the controller should re-sense now, else null. */
  update(input: ControllerInput, features: { readonly [name: string]: number }, stopDistanceM: number, arrivalRadiusM: number): string | null {
    const free = features.freeDistanceM;
    const forward = input.ranges?.forwardM ?? null;
    if (!staleHold(input, features, stopDistanceM, arrivalRadiusM)) {
      this.since = null;
      return null;
    }
    this.since ??= input.tick;
    if (input.tick - this.since < STALL.ticks || input.tick - this.lastReset < STALL.minRepeatTicks) return null;
    this.since = null;
    this.lastReset = input.tick;
    this.resets += 1;
    const range = forward === null ? "no forward range return" : `forward range ${forward.toFixed(2)} m`;
    return `Controller re-sense at tick ${input.tick}: hovering ${STALL.ticks} ticks with the goal ahead, held by a looming free distance of ${free.toFixed(2)} m (${range}); its temporal state was reset so it measures again.`;
  }
}

/** Hovering with the goal ahead, held at the stop distance by a known looming free distance that the forward range (if any) contradicts. */
function staleHold(input: ControllerInput, features: { readonly [name: string]: number }, stopDistanceM: number, arrivalRadiusM: number): boolean {
  const free = features.freeDistanceM;
  const v = input.previous.velocityBody;
  const goal = input.goal;
  const forward = input.ranges?.forwardM ?? null;
  const held = Number.isFinite(free) && free <= stopDistanceM + STALL.freeMarginM && features.freeDistanceKnown === 1;
  const hovering = Math.hypot(v.x, v.y) < STALL.hoverSpeedMps;
  const goalAhead = goal !== null && Math.abs(goal.bearingRad) <= STALL.aheadRad && goal.distanceM > arrivalRadiusM + 0.2;
  return held && hovering && goalAhead && (forward === null || forward > free + STALL.rangeMarginM);
}
