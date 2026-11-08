/**
 * Person-search detectability: how far along a camera ray a person would still be detected.
 *
 * A person-search footprint (imaging.ts) must contain only points where a person in view would have been
 * reported at confidence ≥ PERSON_DETECTION_CONFIDENCE (contracts/observation.ts, the harness's default
 * personConfidenceThreshold). Each camera's person oracle (rgb.ts, thermal.ts) states its confidence for a person
 * at a point as a budget on the visible optical depth τ between the camera and that point: the oracle reports
 * at least the threshold exactly where τ ≤ budget. Smoke, range, glass (RGB) and heat and fire clutter (thermal)
 * all enter through the budget, so one cut covers them together.
 *
 * Body share: both oracles scale confidence by bodyShare (0.5 + 0.5 × the share of the occupant's sample
 * points in view) and measure smoke and range to one visible sample point. The footprint assumes the least share
 * any sighting has, MIN_BODY_SHARE (one of BODY_SAMPLES points in view), so whenever the oracle's sighting point
 * lies in a footprint its confidence is at least the threshold — also for a person half hidden by furniture or
 * the edge of the image, not only for one in full view.
 *
 * detectableExtent cuts one ray: the largest distance e with τ(d) ≤ budget(d) for every d ≤ e, where τ(d) is the
 * optical depth of the straight segment from the camera to the point at distance d — what the oracles compute
 * (fire.ts opticalDepth) and the exact integral of the extinction along the ray (inside a room the extinction is
 * linear in height, which fire.ts's per-room midpoint rule integrates exactly). A budget non-increasing in
 * distance against a non-decreasing τ crosses once, and every distance returned is checked against τ there, so
 * the cut is never beyond the crossing. visibilityAlong is exact only at its end point: the distance at which it
 * reports a limit reached holds each room's extinction at the mid-height of the whole segment, which over- or
 * under-states τ part way along a sloping ray in stratified smoke by several per cent. It only seeds the search.
 */
import type { Vec3 } from "../../contracts/frames.ts";
import { vec3 } from "../../contracts/frames.ts";
import { extinctionAt, visibilityAlong } from "../fire.ts";
import type { OccupantTruth, WorldState } from "../world-state.ts";

/** Sample points per occupant for line-of-sight checks (sampleHeights). */
export const BODY_SAMPLES = 3;

/**
 * Sample heights above the feet (OccupantTruth.position, as in occupant-body.ts) for line-of-sight checks, by
 * posture: standing 1.7 m, crouched (crouch/cough) 1.0 m, lying (incapacitated) 0.4 m. Ascending.
 */
export function sampleHeights(occupant: OccupantTruth): readonly number[] {
  if (occupant.activity === "incapacitated") return [0.15, 0.25, 0.35];
  return occupant.animation === "crouch" || occupant.animation === "cough" ? [0.3, 0.6, 0.9] : [0.5, 1.0, 1.5];
}

/** Oracle confidence factor for the share of an occupant's sample points in view. */
export function bodyShare(visible: number, total: number): number {
  return 0.5 + (0.5 * visible) / total;
}

/** The least body share of any sighting: one sample point in view. */
export const MIN_BODY_SHARE = bodyShare(1, BODY_SAMPLES);

/**
 * A budget on visible optical depth along one ray. `ends` are ascending piece ends, the last being the ray's
 * length. Within piece k (from ends[k − 1], or 0, to ends[k]) budget(k, d) is continuous and non-increasing in
 * d; from one piece to the next it may only step down (a pane passed, a hotter or more cluttered sample point).
 * A negative budget means no point of the piece qualifies, whatever the smoke.
 */
export interface DepthBudget {
  readonly ends: ArrayLike<number>;
  budget(piece: number, d: number): number;
}

/** Refinement inside the failing piece: at most this many τ evaluations, stopping once the bracket is this narrow. */
const MAX_REFINE_STEPS = 6;
const REFINE_TOLERANCE_M = 0.002;

/**
 * The largest distance e ≤ the ray's length such that τ(d) ≤ budget(d) for every d ≤ e (see the header).
 * - Whole ray: τ at its end (one visibilityAlong, or tauAtEnd when the caller already integrated it) against the
 *   last piece's budget there.
 * - Otherwise a binary search over piece ends finds the first piece whose end fails (a piece end that passes
 *   certifies its whole piece: τ only grows towards that end and the budget only shrinks).
 * - Inside the failing piece, a bracketed Newton search on f(d) = τ(d) − budget(d), seeded with visibilityAlong's
 *   crossing estimate; f grows at least as fast as the extinction at d (fire.ts extinctionAt, the derivative of
 *   τ) plus the budget's own fall. Only distances where f ≤ 0 was evaluated are ever returned.
 */
export function detectableExtent(world: WorldState, origin: Vec3, dir: Vec3, b: DepthBudget, tauAtEnd?: number): number {
  const n = b.ends.length;
  if (n === 0) return 0;
  if (tauAtEnd !== undefined && tauAtEnd <= b.budget(n - 1, b.ends[n - 1])) return b.ends[n - 1];
  const failing = firstFailingPiece(world, origin, dir, b);
  if (failing === null) return b.ends[n - 1];
  const lo = failing.piece === 0 ? 0 : b.ends[failing.piece - 1];
  // The failing piece's budget may start below τ where the last passing piece ended (a step down): cut there.
  if (!(failing.tauAtStart <= b.budget(failing.piece, lo))) return lo;
  return refineCrossing(world, origin, dir, b, failing.piece, lo, failing.seed);
}

interface FailingPiece {
  readonly piece: number;
  /** Exact τ at the piece's start (0 for the first piece). */
  readonly tauAtStart: number;
  /** visibilityAlong's estimate of where τ crosses the piece's budget at its end. */
  readonly seed: number;
}

/** Binary search for the first piece whose end fails, or null when the whole ray passes. */
function firstFailingPiece(world: WorldState, origin: Vec3, dir: Vec3, b: DepthBudget): FailingPiece | null {
  /** Piece k's end against its budget there: τ is exact when visibilityAlong is not cut short; else an estimate of where it crosses. */
  const probe = (k: number): { readonly pass: boolean; readonly tau: number; readonly reach: number } => {
    const limit = b.budget(k, b.ends[k]);
    if (!(limit >= 0)) return { pass: false, tau: Number.NaN, reach: 0 };
    const along = visibilityAlong(world, origin, dir, b.ends[k], limit);
    return along.distanceM >= b.ends[k] ? { pass: true, tau: along.tau, reach: b.ends[k] } : { pass: false, tau: Number.NaN, reach: along.distanceM };
  };
  let failed = b.ends.length - 1;
  const whole = probe(failed);
  if (whole.pass) return null;
  let passed = -1;
  let tauAtStart = 0;
  let seed = whole.reach;
  while (failed - passed > 1) {
    const mid = (passed + failed) >> 1;
    const result = probe(mid);
    if (result.pass) {
      passed = mid;
      tauAtStart = result.tau;
    } else {
      failed = mid;
      seed = result.reach;
    }
  }
  return { piece: failed, tauAtStart, seed };
}

/** Bracketed Newton search for the crossing inside piece k, from a start where it passes; returns the last passing distance found. */
function refineCrossing(world: WorldState, origin: Vec3, dir: Vec3, b: DepthBudget, k: number, start: number, seed: number): number {
  let lo = start;
  let hi = b.ends[k];
  let guess = seed;
  for (let step = 0; step < MAX_REFINE_STEPS && hi - lo > REFINE_TOLERANCE_M; step++) {
    if (!(guess > lo && guess < hi)) guess = (lo + hi) / 2;
    const budget = b.budget(k, guess);
    const excess = visibilityAlong(world, origin, dir, guess).tau - budget;
    if (excess <= 0) lo = guess;
    else hi = guess;
    const h = Math.min(REFINE_TOLERANCE_M, hi - guess);
    const fall = h > 0 ? Math.max(0, (budget - b.budget(k, guess + h)) / h) : 0;
    const slope = extinctionAt(world, vec3(origin.x + dir.x * guess, origin.y + dir.y * guess, origin.z + dir.z * guess)) + fall;
    guess = slope > 0 ? guess - excess / slope : Number.NaN;
  }
  return lo;
}
