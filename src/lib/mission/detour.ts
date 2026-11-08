/**
 * Range-blocked detour: the follower's escape from an obstacle that is not in the floor-plan prior (a tree,
 * debris, a moved obstruction) and sits on the planned leg.
 *
 * The reflex controller brakes for it (looming and forward range) but cannot leave the local minimum on its
 * own: the goal bearing points straight into the obstacle, and range braking and goal steering cancel out.
 * When the forward range reading (the aircraft's own planar lidar sector, never simulator truth) is inside
 * triggerM while the path continues through that range roughly ahead, the follower inserts two waypoints:
 * a sidestep toward the side whose lateral range reading is longer (a missing return counts as open), bounded
 * by that reading less a clearance, then a pass point beyond the obstacle along the original heading. The
 * controller still flies every metre (braking, turning, range assistance); the detour only moves its goal.
 * The side is kept for follow-up triggers shortly after a detour, so it does not flip-flop. Detours only
 * start outside and at least openSpaceM from the building's footprint: near walls, windows and doors a short
 * forward reading is the aperture's own frame, which the path deliberately threads.
 */
import type { Tick } from "../contracts/clock.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { vec3 } from "../contracts/frames.ts";

export const DETOUR = Object.freeze({
  triggerM: 1.2,
  offsetM: 2.5,
  minOffsetM: 1.0,
  /** Lateral clearance kept from the sidestep side's range reading. */
  sideClearanceM: 0.9,
  passM: 3.0,
  reachedM: 0.5,
  maxTicks: 2000,
  keepSideTicks: 1000,
  /** Lidar range used for a missing (open) return. */
  openRangeM: 8,
  /** Largest bearing to the path target (rad) for which the path counts as running into the reading. */
  aheadRad: 0.6,
  /** Minimum horizontal distance from every room of the prior for a detour to start. */
  openSpaceM: 2.0,
});

export interface DetourRanges {
  readonly forwardM: number | null;
  readonly leftM: number | null;
  readonly rightM: number | null;
}

export interface DetourInput {
  readonly tick: Tick;
  readonly pose: Vec3;
  readonly yawRad: number;
  readonly ranges: DetourRanges | null;
  /** Bearing from the nose to the path's pursuit target (rad, left positive). */
  readonly bearingRad: number;
  readonly remainingM: number;
  /** The current leg is a climb or descent in place. */
  readonly vertical: boolean;
  /** Outside and clear of the building (the follower's judgement from the prior); detours only happen there. */
  readonly inOpenSpace: boolean;
}

export class RangeDetour {
  private waypoints: Vec3[] = [];
  private started: Tick = 0;
  private side: 1 | -1 | null = null;
  private lastTick: Tick = -Infinity;
  /** Detours started this run (diagnostics). */
  count = 0;

  reset(): void {
    this.waypoints = [];
    this.side = null;
    this.lastTick = -Infinity;
  }

  get active(): boolean {
    return this.waypoints.length > 0;
  }

  /** The detour waypoint to steer toward this step, or null to follow the planned path. */
  update(input: DetourInput): Vec3 | null {
    if (this.waypoints.length > 0) {
      while (this.waypoints.length > 0 && horizontal(input.pose, this.waypoints[0]) <= DETOUR.reachedM) this.waypoints.shift();
      if (input.tick - this.started > DETOUR.maxTicks) this.waypoints = [];
      if (this.waypoints.length > 0 && !this.blockedAgain(input)) return this.waypoints[0];
      this.waypoints = [];
      this.lastTick = input.tick;
    }
    return this.trigger(input);
  }

  /** Blocked again while heading for a waypoint: restart from here rather than pushing into it. */
  private blockedAgain(input: DetourInput): boolean {
    const forward = input.ranges?.forwardM ?? null;
    const wp = this.waypoints[0];
    const dx = wp.x - input.pose.x;
    const dy = wp.y - input.pose.y;
    const along = Math.cos(input.yawRad) * dx + Math.sin(input.yawRad) * dy;
    const across = -Math.sin(input.yawRad) * dx + Math.cos(input.yawRad) * dy;
    const facing = Math.abs(Math.atan2(across, along)) <= DETOUR.aheadRad;
    return facing && forward !== null && forward < DETOUR.triggerM / 2;
  }

  private trigger(input: DetourInput): Vec3 | null {
    const forward = blockingRange(input);
    if (forward === null || input.ranges === null) return null;
    const kept = this.side !== null && input.tick - this.lastTick <= DETOUR.keepSideTicks ? this.side : null;
    const choice = chooseSide(input.ranges, input.bearingRad, kept);
    if (choice === null) return null;
    const { side, offset } = choice;
    const c = Math.cos(input.yawRad);
    const s = Math.sin(input.yawRad);
    const p = input.pose;
    const step = vec3(p.x - s * side * offset, p.y + c * side * offset, p.z);
    const pass = vec3(step.x + c * (forward + DETOUR.passM), step.y + s * (forward + DETOUR.passM), p.z);
    this.waypoints = [step, pass];
    this.side = side;
    this.started = input.tick;
    this.lastTick = input.tick;
    this.count += 1;
    return step;
  }
}

/** The forward range reading when it blocks the path ahead (a level leg running into it), else null. */
function blockingRange(input: DetourInput): number | null {
  const forward = input.ranges?.forwardM ?? null;
  if (input.vertical || !input.inOpenSpace || forward === null || forward > DETOUR.triggerM) return null;
  return input.remainingM > forward + 0.5 && Math.abs(input.bearingRad) <= DETOUR.aheadRad ? forward : null;
}

/** Sidestep side (+1 left, −1 right) and offset: the kept side, else the longer lateral reading; null when neither has room. */
function chooseSide(ranges: DetourRanges, bearingRad: number, kept: 1 | -1 | null): { side: 1 | -1; offset: number } | null {
  const left = ranges.leftM ?? DETOUR.openRangeM;
  const right = ranges.rightM ?? DETOUR.openRangeM;
  const byRange: 1 | -1 = left > right ? 1 : -1;
  const preferred: 1 | -1 = kept ?? (Math.abs(left - right) > 0.1 ? byRange : bearingRad >= 0 ? 1 : -1);
  for (const side of [preferred, -preferred as 1 | -1]) {
    const offset = Math.min(DETOUR.offsetM, (side === 1 ? left : right) - DETOUR.sideClearanceM);
    if (offset >= DETOUR.minOffsetM) return { side, offset };
  }
  return null;
}

function horizontal(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
