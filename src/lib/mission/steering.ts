/**
 * Steering: turns the harness's active goal into the goal estimate the motion controller receives.
 *
 * The harness owns WHERE the aircraft may go (the executing action's goal); the reflex controller owns HOW
 * it flies there (braking, turning, range assistance). Between them, this follower plans a path through the
 * floor-plan prior (steering-graph.ts) and tracks it by pure pursuit: the controller steers toward a point
 * lookaheadM ahead along the path (apertureLookaheadM near an opening on the path), while the reported distance is the remaining path length, so it neither
 * stops at intermediate waypoints nor cuts through walls toward a goal in another room. An optional focus
 * (what the action looks at: a window, an aim point, a track) adds an approach point so the aircraft arrives
 * facing it, and is reported as the goal's face bearing so the controller turns in place to keep facing it
 * while it holds the goal (command.ts). Inputs are the estimated pose and belief only.
 *
 * Outside, height changes happen over the start or the goal, not along a slanted leg: the camera is pitched
 * only 10° down and the planar lidar sees only its own height, so a slow climb along a long leg can rise into
 * an overhang (a tree canopy) that neither can see. The follower climbs in place to the leg's height, flies
 * level, and descends over an exterior goal. A climb or descent point closer than facadeClearanceM to the
 * building's footprint (the prior's room outlines) is first moved horizontally out to that clearance, flown at
 * the lower height: walls above a door and overhangs (an entrance canopy) are not in the prior and neither
 * sensor sees them overhead (measured on Troy: climbing in place 0.14 m outside the front door, the aircraft
 * struck the wall above it at 0.71 m/s; the canopy outside reaches 1.95 m from the room outline). On a vertical leg the controller gets the horizontal offset as
 * its goal distance, so it holds position while the height error drives the climb. Longer exterior
 * transits fly at a transit height (the runtime uses 1 m below the envelope ceiling): low obstacles that the
 * floor plan does not show (trees, poles, vehicles) mostly sit below it; the reflexes and range assistance
 * stay responsible for anything that does not.
 */
import type { Tick } from "../contracts/clock.ts";
import type { BeliefSnapshot, HazardEvidence } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance, vec3, worldPointToBody } from "../contracts/frames.ts";
import type { GoalEstimate } from "../navigation/reflex/types.ts";
import type { DetourRanges } from "./detour.ts";
import { DETOUR, RangeDetour } from "./detour.ts";
import type { FlightPath } from "./steering-graph.ts";
import { burningFires, clearOfFires, EXTERIOR, findFlightPath, polygonDistance, spaceOf } from "./steering-graph.ts";

export const FOLLOWER = Object.freeze({
  lookaheadM: 0.8,
  approachM: 1.0,
  replanTicks: 100,
  offPathM: 1.5,
  /**
   * Added to the reported goal distance so the shared mapper's 0.3 m arrival radius ends inside the harness's
   * 0.3 m arrival tolerance instead of exactly on it.
   */
  arrivalBiasM: 0.12,
  /** Exterior height changes larger than this are flown vertically over the start or goal. */
  climbInPlaceM: 0.5,
  /** Exterior climbs and descents shorter than this horizontally are not inserted (climbInPlace). */
  verticalLegM: 0.25,
  /**
   * A leg is flown as vertical (climb or descend in place) only when it is plumb, as the exterior profile makes
   * it: a short leg from the start to a nearby node at another height is an ordinary slanted leg (measured on
   * Troy: 0.23 m from the stair's bottom node and 0.25 m above it, every other replan made the aircraft drop onto
   * the node, the next one climbed again, and the goal flip kept the stale-looming re-sense from firing).
   */
  plumbM: 0.01,
  /**
   * Exterior runs at least this long (horizontally) are flown at the transit height. A route's waypoints follow
   * one another a few metres apart along the facade, and each is a new goal: at 5 m each 2–8 m hop of the main
   * run's return went out from the facade, up to the 7 m transit height and back down, the distance to the next
   * waypoint rose to 16 m and the return was aborted for lack of progress.
   */
  transitMinM: 10,
  /** On an exterior leg shorter than transitMinM, a height change up to this much is flown slanted, not in place. */
  slantMaxM: 1.5,
  /** A final exterior leg shorter than this is an approach: the descent happens before it. */
  approachLegM: 2,
  /** Horizontal distance to an opening on the path within which the aircraft is in close quarters. */
  apertureNearM: 1.5,
  /**
   * Pursuit lookahead in close quarters: a full lookahead past the path's turn at an opening's centre or
   * portal cuts the corner toward a door jamb (pure pursuit flies the chord, not the polyline).
   */
  apertureLookaheadM: 0.4,
  /** Shortest pursuit lookahead (near a fire the chord to the target must keep its clearance). */
  minLookaheadM: 0.2,
  /** A focus horizontally closer than this has no usable bearing: no face bearing is reported. */
  faceMinM: 0.2,
  /** Exterior climbs and descents happen at least this far (horizontally) from every room outline of the prior. */
  facadeClearanceM: 2.5,
});

export interface SteeringRequest {
  readonly belief: BeliefSnapshot;
  readonly goal: Vec3;
  readonly focus: Vec3 | null;
  readonly clearanceM: number;
  /** The aircraft's latest range readings (planar lidar sectors), for the range-blocked detour. */
  readonly ranges?: DetourRanges | null;
  /** Exterior transit height (estimated world z); null keeps exterior legs at their endpoints' heights. */
  readonly transitZ?: number | null;
}

export interface SteeringOutput {
  readonly goal: GoalEstimate;
  /** The point the controller steers toward this step (estimated world frame). */
  readonly target: Vec3;
  readonly remainingM: number;
  /** Openings and stairs the current path crosses; empty for a direct leg. */
  readonly via: readonly string[];
  readonly planned: boolean;
  /** A range-blocked detour waypoint is being flown instead of the planned path. */
  readonly detour: boolean;
  /** Within apertureNearM of a window or door the path passes through (close quarters). */
  readonly nearAperture: boolean;
}

interface Plan {
  readonly key: string;
  readonly tick: Tick;
  readonly path: FlightPath;
  segment: number;
}

export class PathFollower {
  private plan: Plan | null = null;
  readonly detour = new RangeDetour();

  reset(): void {
    this.plan = null;
    this.detour.reset();
  }

  steer(request: SteeringRequest): SteeringOutput {
    const { belief } = request;
    const pose = belief.pose.position;
    const plan = this.currentPlan(request);
    const prior = belief.mapPrior;
    const nearAperture = nearOpening(plan.path.via, prior, pose);
    const tracked = pursue(plan, pose, nearAperture ? FOLLOWER.apertureLookaheadM : FOLLOWER.lookaheadM, burningFires(belief.hazards));
    const estimate = { position: pose, yawRad: belief.pose.yawRad };
    const vertical = verticalLeg(plan);
    const pathBody = worldPointToBody(estimate, tracked.target);
    const inOpenSpace = spaceOf(prior, pose) === EXTERIOR && prior.rooms.every(room => polygonDistance(room.polygon, pose.x, pose.y) >= DETOUR.openSpaceM);
    const detour = this.detour.update({ tick: belief.tick, pose, yawRad: belief.pose.yawRad, ranges: request.ranges ?? null, bearingRad: Math.atan2(pathBody.y, pathBody.x), remainingM: tracked.remainingM, vertical: vertical !== null, inOpenSpace });
    const target = detour ?? vertical ?? tracked.target;
    const body = worldPointToBody(estimate, target);
    const end = plan.path.points[plan.path.points.length - 1] ?? target;
    const distanceM = detour !== null
      ? distance(pose, detour) + distance(detour, end) + FOLLOWER.arrivalBiasM
      : vertical !== null ? Math.hypot(vertical.x - pose.x, vertical.y - pose.y) : tracked.remainingM + FOLLOWER.arrivalBiasM;
    const goal: GoalEstimate = { bearingRad: Math.atan2(body.y, body.x), distanceM, heightErrorM: target.z - pose.z, faceBearingRad: faceBearing(estimate, request.focus) };
    return { goal, target, remainingM: tracked.remainingM, via: plan.path.via, planned: plan.path.points.length > 2, detour: detour !== null, nearAperture };
  }

  /** The plan to track: kept while its goal is unchanged, fresh and on it (and throughout a detour), else replanned from the estimated pose. */
  private currentPlan(request: SteeringRequest): Plan {
    const { belief } = request;
    const pose = belief.pose.position;
    const key = planKey(request);
    const plan = this.plan;
    const keepDuringDetour = this.detour.active && plan !== null && plan.key === key;
    if (plan !== null && (keepDuringDetour || (plan.key === key && belief.tick - plan.tick < FOLLOWER.replanTicks && !offPath(plan, pose)))) return plan;
    this.plan = { key, tick: belief.tick, path: planPath(request), segment: 0 };
    return this.plan;
  }
}

/** Within apertureNearM (and the opening's height) of a window or door the path passes through. */
function nearOpening(via: readonly string[], prior: BeliefSnapshot["mapPrior"], pose: Vec3): boolean {
  return via.some(id => {
    const opening = prior.openings.find(o => o.id === id);
    return opening !== undefined && Math.hypot(opening.center.x - pose.x, opening.center.y - pose.y) <= FOLLOWER.apertureNearM && Math.abs(opening.center.z - pose.z) <= opening.heightM;
  });
}

/** Body-frame bearing to the focus from the estimated pose; null without a focus or when it is (nearly) overhead. */
function faceBearing(estimate: { position: Vec3; yawRad: number }, focus: Vec3 | null): number | null {
  if (focus === null) return null;
  const body = worldPointToBody(estimate, focus);
  return Math.hypot(body.x, body.y) < FOLLOWER.faceMinM ? null : Math.atan2(body.y, body.x);
}

/** The top (or bottom) of the current leg when it is vertical (plumb), else null. */
function verticalLeg(plan: Plan): Vec3 | null {
  const points = plan.path.points;
  if (plan.segment >= points.length - 1) return null;
  const a = points[plan.segment];
  const b = points[plan.segment + 1];
  return Math.hypot(b.x - a.x, b.y - a.y) < FOLLOWER.plumbM && Math.abs(b.z - a.z) > FOLLOWER.verticalLegM ? b : null;
}

function planPath(request: SteeringRequest): FlightPath {
  const path = routePath(request);
  return { ...path, points: exteriorProfile(path.points, request.belief.mapPrior, request.transitZ ?? null) };
}

/**
 * Exterior height profile. A run of consecutive exterior points spanning at least transitMinM horizontally
 * is flown at the transit height (when one is given and higher): climb in place over the run's first point,
 * level at transit height, descend in place over its last point. Otherwise a climb at the start or a descent
 * at the goal larger than climbInPlaceM is still flown vertically instead of along a slanted leg.
 */
export function exteriorProfile(points: readonly Vec3[], prior: BeliefSnapshot["mapPrior"], transitZ: number | null): Vec3[] {
  const outside = points.map(p => spaceOf(prior, p) === EXTERIOR);
  const out: Vec3[] = [];
  let i = 0;
  while (i < points.length) {
    if (!outside[i] || transitZ === null) {
      out.push(points[i++]);
      continue;
    }
    let j = i;
    let span = 0;
    while (j + 1 < points.length && outside[j + 1]) {
      span += Math.hypot(points[j + 1].x - points[j].x, points[j + 1].y - points[j].y);
      j++;
    }
    const top = Math.max(transitZ, ...points.slice(i, j + 1).map(p => p.z));
    if (j === i || span < FOLLOWER.transitMinM) {
      for (let k = i; k <= j; k++) out.push(points[k]);
    } else {
      // Descend over the run's last point, or over the one before it when the final leg is a short approach.
      const last = j - 1 > i && Math.hypot(points[j].x - points[j - 1].x, points[j].y - points[j - 1].y) < FOLLOWER.approachLegM ? j - 1 : j;
      const up = clearOfFacade(prior, points[i]);
      const down = clearOfFacade(prior, points[last]);
      out.push(points[i], vec3(up.x, up.y, points[i].z), vec3(up.x, up.y, top));
      for (let k = i + 1; k < last; k++) out.push(vec3(points[k].x, points[k].y, top));
      out.push(vec3(down.x, down.y, top), vec3(down.x, down.y, points[last].z));
      for (let k = last; k <= j; k++) out.push(points[k]);
    }
    i = j + 1;
  }
  return climbInPlace(dedupe(out), prior);
}

/**
 * A leg's height change is flown in place (over its start when climbing, over its end when descending): more
 * than climbInPlaceM, on a leg long enough to slant, unless the leg is a short hop (under transitMinM) changing
 * height by at most slantMaxM, which is flown slanted like the hops between a route's waypoints.
 */
function inPlace(a: Vec3, b: Vec3): boolean {
  const horizontal = Math.hypot(b.x - a.x, b.y - a.y);
  const rise = Math.abs(b.z - a.z);
  if (rise <= FOLLOWER.climbInPlaceM || horizontal < FOLLOWER.verticalLegM) return false;
  return horizontal >= FOLLOWER.transitMinM || rise > FOLLOWER.slantMaxM;
}

/** Exterior climbs over the start and descents over the goal instead of along a slanted first or last leg. */
export function climbInPlace(points: readonly Vec3[], prior: BeliefSnapshot["mapPrior"]): Vec3[] {
  const out = [...points];
  if (out.length < 2) return out;
  const [a, b] = out;
  if (b.z > a.z && inPlace(a, b) && spaceOf(prior, a) === EXTERIOR) {
    const up = clearOfFacade(prior, a);
    out.splice(1, 0, ...dedupe([a, vec3(up.x, up.y, a.z)]).slice(1), vec3(up.x, up.y, b.z));
  }
  const n = out.length;
  const [p, q] = [out[n - 2], out[n - 1]];
  if (p.z > q.z && inPlace(p, q) && spaceOf(prior, q) === EXTERIOR) {
    const down = clearOfFacade(prior, q);
    out.splice(n - 1, 0, ...dedupe([vec3(down.x, down.y, p.z), vec3(down.x, down.y, q.z), q]).slice(0, -1));
  }
  return dedupe(out);
}

/**
 * The nearest point (horizontally, at p's height) at least facadeClearanceM from every room outline of the
 * prior: p itself when it already is, else the first clear point stepping outward, straight away from the
 * nearest outline first and then on 16 bearings; p when none is found within 4 m (the old behaviour).
 */
export function clearOfFacade(prior: BeliefSnapshot["mapPrior"], p: Vec3): Vec3 {
  const clearance = (x: number, y: number) => Math.min(...prior.rooms.map(room => polygonDistance(room.polygon, x, y)));
  if (prior.rooms.length === 0 || clearance(p.x, p.y) >= FOLLOWER.facadeClearanceM) return p;
  const e = 0.05;
  const gx = clearance(p.x + e, p.y) - clearance(p.x - e, p.y);
  const gy = clearance(p.x, p.y + e) - clearance(p.x, p.y - e);
  const away = Math.hypot(gx, gy) > 1e-9 ? [Math.atan2(gy, gx)] : [];
  const bearings = [...away, ...Array.from({ length: 16 }, (_, k) => (2 * Math.PI * k) / 16)];
  for (let step = 0.25; step <= 4 + 1e-9; step += 0.25) {
    for (const bearing of bearings) {
      const x = p.x + step * Math.cos(bearing);
      const y = p.y + step * Math.sin(bearing);
      if (clearance(x, y) >= FOLLOWER.facadeClearanceM) return vec3(x, y, p.z);
    }
  }
  return p;
}

function dedupe(points: readonly Vec3[]): Vec3[] {
  return points.filter((p, k) => k === 0 || distance(p, points[k - 1]) > 1e-6);
}

function routePath(request: SteeringRequest): FlightPath {
  const { belief, goal } = request;
  const base = { prior: belief.mapPrior, openings: belief.openings, hazards: belief.hazards, tick: belief.tick, from: belief.pose.position, clearanceM: request.clearanceM };
  const approach = approachPoint(request);
  if (approach !== null) {
    const toApproach = findFlightPath({ ...base, goal: approach });
    if (toApproach !== null) return { ...toApproach, points: [...toApproach.points, goal], lengthM: toApproach.lengthM + distance(approach, goal) };
  }
  const direct = findFlightPath({ ...base, goal });
  if (direct !== null) return direct;
  // No passable connection in the prior: fly straight and leave obstacles to the reflexes and range sensing,
  // unless the straight line passes a burning fire; then there is no path and the aircraft holds where it is.
  const from = belief.pose.position;
  if (!clearOfFires(burningFires(belief.hazards), from, goal)) return { points: [from], via: [], lengthM: 0 };
  return { points: [from, goal], via: [], lengthM: distance(from, goal) };
}

/** A point approachM behind the goal, away from the focus, in the goal's own space; null when not useful. */
function approachPoint(request: SteeringRequest): Vec3 | null {
  const { goal, focus, belief } = request;
  if (focus === null) return null;
  const dx = goal.x - focus.x;
  const dy = goal.y - focus.y;
  const h = Math.hypot(dx, dy);
  if (h < 0.3 || distance(belief.pose.position, goal) < FOLLOWER.approachM) return null;
  const p = vec3(goal.x + (dx / h) * FOLLOWER.approachM, goal.y + (dy / h) * FOLLOWER.approachM, goal.z);
  return spaceOf(belief.mapPrior, p) === spaceOf(belief.mapPrior, goal) ? p : null;
}

function planKey(request: SteeringRequest): string {
  const r = (v: Vec3) => `${Math.round(v.x * 50)},${Math.round(v.y * 50)},${Math.round(v.z * 50)}`;
  const openings = request.belief.openings.map(o => `${o.openingId}:${o.state}`).sort().join("|");
  return `${r(request.goal)}/${request.focus === null ? "-" : r(request.focus)}/${openings}/${request.transitZ ?? "-"}`;
}

function offPath(plan: Plan, pose: Vec3): boolean {
  const points = plan.path.points;
  const last = Math.min(points.length - 1, plan.segment + 2);
  let best = Infinity;
  for (let i = plan.segment; i < last; i++) best = Math.min(best, closestOnSegment(points[i], points[i + 1], pose).d);
  return points.length > 1 && best > FOLLOWER.offPathM;
}

/**
 * Closest point on the path at or after the current segment, the lookahead target and the remaining length.
 * The lookahead shrinks (to minLookaheadM) while the straight chord to the target would cut into a fire's
 * clearance: pure pursuit flies the chord, and the path bends around the fire.
 */
function pursue(plan: Plan, pose: Vec3, lookaheadM: number, fires: readonly HazardEvidence[]): { target: Vec3; remainingM: number } {
  const points = plan.path.points;
  if (points.length < 2) return { target: points[points.length - 1] ?? pose, remainingM: distance(pose, points[points.length - 1] ?? pose) };
  let bestSegment = plan.segment;
  let bestT = 0;
  let bestD = Infinity;
  for (let i = plan.segment; i < Math.min(points.length - 1, plan.segment + 3); i++) {
    const c = closestOnSegment(points[i], points[i + 1], pose);
    if (c.d < bestD - 1e-9) [bestSegment, bestT, bestD] = [i, c.t, c.d];
  }
  plan.segment = bestSegment;
  let remaining = distance(points[bestSegment], points[bestSegment + 1]) * (1 - bestT);
  for (let i = bestSegment + 1; i < points.length - 1; i++) remaining += distance(points[i], points[i + 1]);
  // On the last leg, report the straight distance to the goal so a lateral offset never reads as arrival.
  const onLastLeg = bestSegment === points.length - 2;
  const remainingM = onLastLeg ? Math.max(remaining, distance(pose, points[points.length - 1])) : remaining;
  let ahead = lookaheadM;
  let target = walk(points, bestSegment, bestT, ahead);
  while (ahead > FOLLOWER.minLookaheadM && !clearOfFires(fires, pose, target)) {
    ahead = Math.max(FOLLOWER.minLookaheadM, ahead / 2);
    target = walk(points, bestSegment, bestT, ahead);
  }
  return { target, remainingM };
}

/** The point `ahead` metres along the polyline from parameter t of segment i (the end point if it runs out). */
function walk(points: readonly Vec3[], i: number, t: number, ahead: number): Vec3 {
  let segment = i;
  let left = ahead;
  let from = lerp(points[segment], points[segment + 1], t);
  while (segment < points.length - 1) {
    const to = points[segment + 1];
    const d = distance(from, to);
    if (d >= left) return lerp(from, to, d > 0 ? left / d : 0);
    left -= d;
    from = to;
    segment += 1;
  }
  return points[points.length - 1];
}

function closestOnSegment(a: Vec3, b: Vec3, p: Vec3): { t: number; d: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2));
  return { t, d: distance(p, lerp(a, b, t)) };
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}
