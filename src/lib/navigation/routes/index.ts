/**
 * Route assessor: judges a return, alternate-return or evacuation route from the floor-plan prior and fresh
 * observations only. Truth-free by construction: it imports contracts and the harness policy, never the
 * simulator or the evaluator, and it reads nothing but the BeliefSnapshot it is given.
 *
 * Status (see assess.ts for the details):
 * - "unsupported": no path the traveler can pass (blocked openings; windows for occupants; doors the
 *   aircraft cannot open), or fire evidence captured after the last intervention, within the cited-evidence
 *   age, overlaps the walking corridor of every remaining path. The reason names the blocking evidence.
 * - "supported": a passable path whose rooms are each at least ROUTE_MIN_FRESH_SEARCHED_FRACTION
 *   person-searched at adequate quality after the intervention and within policy.routeEvidenceMaxAgeTicks
 *   (30 s by default, the limit H15 applies to cited evidence), whose openings have states observed after the
 *   intervention within the same limit, and where any earlier fire beside the route has been
 *   re-observed after the intervention showing no fire. Suppression alone never makes a route usable.
 * - "unknown": otherwise; the reason lists the rooms, openings and fire locations to inspect.
 * Waypoints run from the request's start through opening approaches and centres, stair ends and corners to
 * the destination; estimatedDurationS is the path length over speedMps.
 */
import type { Tick } from "../../contracts/clock.ts";
import type { BeliefSnapshot, RouteAssessment } from "../../contracts/evidence.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import type { RouteId } from "../../contracts/ids.ts";
import type { HarnessPolicy } from "../../harness/policy.ts";
import { assess } from "./assess.ts";

export interface RouteRequest {
  readonly id: RouteId;
  readonly purpose: "return" | "alternate_return" | "evacuation";
  readonly from: Vec3;
  readonly destination: { readonly kind: "point"; readonly point: Vec3 } | { readonly kind: "exit"; readonly exitId: string; readonly then: Vec3 | null };
  readonly traveler: "drone" | "occupant";
  readonly speedMps: number;
}

export interface RouteAssessorInput {
  readonly belief: BeliefSnapshot;
  readonly tick: Tick;
  /** ActionHarness.lastInterventionAt(tick): the latest spray or breach with effects (the tick itself while spraying). */
  readonly lastInterventionTick: Tick | null;
  readonly policy: HarnessPolicy;
}

/** assessedTick = input.tick. Throws RangeError only for a malformed request (non-finite start, speed ≤ 0). */
export function assessRoute(input: RouteAssessorInput, request: RouteRequest): RouteAssessment {
  return assess(input, request);
}

export { ROUTE_EVIDENCE_MAX_AGE_TICKS, ROUTE_MIN_FRESH_SEARCHED_FRACTION } from "./support.ts";
export { CORRIDOR_HALF_WIDTH_M } from "./corridor.ts";
