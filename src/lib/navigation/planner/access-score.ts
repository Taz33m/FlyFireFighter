/**
 * Breach access scoring, shared by the candidate factory (which decides whether a look at an unobserved window
 * is worth offering) and the local planner (which ranks breaches and looks). One function, so both always
 * agree on which window is better placed.
 */
import { deepFreeze } from "../../contracts/ids.ts";
import type { BreachAccess } from "./types.ts";

/** Weights of a window's access (types.ts BreachAccess); the local planner exposes them as PLANNER_WEIGHTS.breach. */
export const BREACH_ACCESS_WEIGHTS = deepFreeze({
  /** A drone-passable way to the fire's, a possible occupant's or a reported room... */
  connected: 12,
  /** ...less this per opening crossed (a stair counts STAIR_HOPS), never below zero. */
  perHop: 3,
  /** Only closed doors (or no interior opening) lead out of the room: entering would strand the aircraft. */
  closedIn: 15,
  /** A possible occupant is in the room, beyond the exclusion margin: glass stays out while another entry serves. */
  occupiedRoom: 20,
  /** No exterior approach to the window in the floor-plan prior. */
  noApproach: 20,
  /** Times the share of the debris region in view from the standoff. */
  visibility: 6,
  /** The share in view falls short of the harness's breach coverage floor: H6 would refuse it for coverage. */
  shortOfCoverage: 6,
  /** Times how comfortably the aircraft fits the pane. */
  aperture: 4,
  /** The pane leaves less than half the obstacle clearance on each side of the aircraft (fit below TIGHT_FIT): too tight to enter with a margin. */
  tightPane: 15,
});

/** Below this aperture fit the pane leaves less than half the aircraft's obstacle clearance on each side. */
export const TIGHT_FIT = 0.5;

/** The largest positive access score a window can reach. */
export const MAX_ACCESS_BONUS = BREACH_ACCESS_WEIGHTS.connected + BREACH_ACCESS_WEIGHTS.visibility + BREACH_ACCESS_WEIGHTS.aperture;

/**
 * An unobserved window may turn out blocked, or its plan may be wrong: until it is seen, a positive access
 * score counts at this share (a negative one counts in full).
 */
export const UNCONFIRMED_ACCESS_FACTOR = 0.75;

/** The access score of a window whose closed state has been observed. */
export function breachAccessScore(access: BreachAccess): number {
  const B = BREACH_ACCESS_WEIGHTS;
  const connection = access.hopsToTarget === null ? 0 : Math.max(0, B.connected - B.perHop * access.hopsToTarget);
  return connection
    - (access.closedIn ? B.closedIn : 0)
    - (access.occupiedBy !== null ? B.occupiedRoom : 0)
    - (access.approach === false ? B.noApproach : 0)
    - (access.clearsCoverage ? 0 : B.shortOfCoverage)
    - (access.apertureFit < TIGHT_FIT ? B.tightPane : 0)
    + B.visibility * clamp01(access.visibleFraction)
    + B.aperture * clamp01(access.apertureFit);
}

/** The access score of a window not yet observed: discounted for being unconfirmed. */
export function unconfirmedAccessScore(access: BreachAccess): number {
  const score = breachAccessScore(access);
  return Math.min(score, score * UNCONFIRMED_ACCESS_FACTOR);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
