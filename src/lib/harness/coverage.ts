/**
 * Rule H6 coverage: which part of an intervention's affected region must have been seen by a recent person
 * search before the action may proceed.
 *
 * The affected region plus the coverage margin (policy.coverageMarginM, a thin edge band — not the wider
 * person margin used for detection blocking) is sampled on a grid, and only occupiable samples the action
 * can physically reach need coverage. Both are derived from the floor-plan prior and opening evidence,
 * never simulator truth: nobody stands inside a wall or slab, rooms on another floor lie beyond a slab, and
 * water or glass travels in straight lines from the action's origin, so a sample behind a wall — or behind
 * an opening last observed closed or blocked — is unreachable. Unobserved openings count as passable.
 * Falling debris and payloads also drop: for them a sample is reachable too when the point above it at the
 * origin's height is reachable in a straight line and the vertical drop between them crosses free space.
 * Only the band people's bodies occupy needs a search: up to PERSON_STANDING_HEIGHT_M above the walking
 * surface (the floor, the ground, or the stair surface over a stair), not the air under the ceiling.
 * Possible-person detections are deliberately not clipped: H6 still blocks on any detection within its
 * uncertainty plus the margin, even behind a wall.
 */
import type { FloorPlanPrior } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import { dot, normalize, sub, vec3 } from "../contracts/frames.ts";
import { distanceToRegion, prism, regionContains, representativePoint, samplePoints } from "../contracts/geometry.ts";
import type { ObservationId } from "../contracts/ids.ts";
import type { Observation } from "../contracts/observation.ts";
import { PERSON_DETECTION_CONFIDENCE } from "../contracts/observation.ts";
import type { HarnessContext } from "./policy.ts";

/**
 * Only a frame that was actually searched for people can say anything about who is in a region. A frame
 * with no person detector (an RGB frame without one, a lidar or ultrasound sweep) establishes geometry, not
 * absence, so it neither covers a region nor clears an earlier possible-person detection.
 */
export function searchedForPeople(observation: Observation): boolean {
  return observation.personSearch !== null;
}

export interface CoverageSummary {
  /** Covered occupiable samples over occupiable samples; 0 when there are none. */
  readonly fraction: number;
  /** Occupiable samples of the region plus the coverage margin. */
  readonly samples: number;
  /** Samples that need no coverage: inside walls or slabs, underground, beyond a slab, above standing height, or out of the action's reach. */
  readonly excludedSamples: number;
  readonly observationIds: readonly ObservationId[];
  /** Required samples no fresh, adequate person search covered (for disclosing where the gap is). */
  readonly uncovered: readonly Vec3[];
}

/**
 * Highest point above the walking surface a person's body can occupy (standing, arms raised). Coverage is a
 * search for people, so it must cover where bodies can be — up to this height above the floor, the ground
 * or a stair's surface — not the air under a ceiling or high outside, which no forward or downward camera
 * at the aircraft's height can see and where nobody stands. Possible-person detections still block at any
 * height (H6 does not clip them).
 */
export const PERSON_STANDING_HEIGHT_M = 2.2;

interface PriorRoom {
  readonly volume: Region;
  /** The room polygon extruded without height limits: distance to it is horizontal distance. */
  readonly column: Region;
  readonly zMin: number;
  readonly zMax: number;
}

/**
 * Occupiable space, from the prior only, for an action originating at height levelZ:
 * - inside a room whose height band contains levelZ (the action's floor, or a room that spans floors), up
 *   to PERSON_STANDING_HEIGHT_M above the room's floor — or above the stair surface where a prior stair
 *   runs under the point, whichever is higher, so nobody on a stair is ever dropped;
 * - not inside a room on another floor, because a slab separates it from the action;
 * - exterior: from the ground floor's elevation up to PERSON_STANDING_HEIGHT_M above it, and farther than
 *   wallClearanceM horizontally from every room polygon. The prior models no exterior structure to stand
 *   on, so a person outside stands on the ground;
 * - otherwise not occupiable: a wall, a slab, the space between floors, the roof, or air above head height.
 * When no room's band contains levelZ (the action's floor is unknown), every room counts.
 */
export function occupancyFilter(prior: FloorPlanPrior, wallClearanceM: number, levelZ: number): (point: Vec3) => boolean {
  const rooms: PriorRoom[] = prior.rooms
    .filter(room => room.polygon.length >= 3)
    .map(room => ({ volume: prism(room.polygon, room.zMin, room.zMax), column: prism(room.polygon, -Infinity, Infinity), zMin: room.zMin, zMax: room.zMax }));
  const onLevel = rooms.filter(room => room.zMin <= levelZ && levelZ <= room.zMax);
  const reachable = onLevel.length > 0 ? onLevel : rooms;
  const groundZ = groundElevationM(prior);
  const stairs = prior.stairs ?? [];
  const withinReach = (point: Vec3, floorZ: number): boolean => point.z <= Math.max(floorZ, stairSurfaceZ(point, stairs)) + PERSON_STANDING_HEIGHT_M;
  return point => {
    const room = reachable.find(candidate => regionContains(candidate.volume, point));
    if (room) return withinReach(point, room.zMin);
    if (rooms.some(candidate => regionContains(candidate.volume, point))) return false;
    return point.z >= groundZ && point.z <= groundZ + PERSON_STANDING_HEIGHT_M && rooms.every(candidate => distanceToRegion(candidate.column, point) > wallClearanceM);
  };
}

/**
 * The walking surface of the highest prior stair under the point: linear from the stair's bottom to its
 * top along its run, across its full width. -Infinity where no stair runs under the point.
 */
export function stairSurfaceZ(point: Vec3, stairs: NonNullable<FloorPlanPrior["stairs"]>): number {
  let best = -Infinity;
  for (const stair of stairs) {
    const ax = stair.top.x - stair.bottom.x;
    const ay = stair.top.y - stair.bottom.y;
    const runSq = ax * ax + ay * ay;
    if (!(runSq > 1e-12)) continue;
    const dx = point.x - stair.bottom.x;
    const dy = point.y - stair.bottom.y;
    const t = (dx * ax + dy * ay) / runSq;
    const lateralM = Math.abs(dx * ay - dy * ax) / Math.sqrt(runSq);
    if (t < 0 || t > 1 || lateralM > stair.widthM / 2) continue;
    best = Math.max(best, stair.bottom.z + t * (stair.top.z - stair.bottom.z));
  }
  return best;
}

export function occupiable(point: Vec3, prior: FloorPlanPrior, wallClearanceM: number, levelZ: number): boolean {
  return occupancyFilter(prior, wallClearanceM, levelZ)(point);
}

/**
 * Coverage of the occupiable part of the region plus the coverage margin by fresh, adequate-quality person
 * searches. `falling` marks an effect that drops under gravity (glass debris, a released payload);
 * `marginOrigin` is the point margin samples are reached from (see requiredSamples).
 *
 * A sample counts when a footprint contains it: person-search footprints hold only points where a person in
 * view would have been reported at PERSON_DETECTION_CONFIDENCE or more (contracts/observation.ts), so a smoky
 * frame covers its clear near field and not its obscured far field. policy.minCoverageQuality only drops frames
 * unusable as a whole. Under a policy whose personConfidenceThreshold exceeds PERSON_DETECTION_CONFIDENCE no
 * footprint counts: it would claim space where a person could be reported below that threshold.
 */
export function coverageOf(region: Region, ctx: HarnessContext, opensOpenings: readonly string[] = [], falling = false, marginOrigin?: Vec3): CoverageSummary {
  const { policy, tick } = ctx;
  const footprintsSupport = policy.personConfidenceThreshold <= PERSON_DETECTION_CONFIDENCE;
  const views = ctx.belief.observations
    .filter(o => footprintsSupport && searchedForPeople(o) && o.quality >= policy.minCoverageQuality && o.captureTick >= tick - policy.coverageFreshTicks)
    .flatMap(o => (o.footprint ? [{ id: o.id, footprint: o.footprint }] : []));
  const { all, points } = requiredSamples(region, ctx, opensOpenings, falling, marginOrigin);
  const used = new Set<ObservationId>();
  const uncovered: Vec3[] = [];
  for (const point of points) {
    const view = views.find(candidate => regionContains(candidate.footprint, point));
    if (view) used.add(view.id);
    else uncovered.push(point);
  }
  const covered = points.length - uncovered.length;
  return { fraction: points.length > 0 ? covered / points.length : 0, samples: points.length, excludedSamples: all.length - points.length, observationIds: [...used], uncovered };
}

/** Floor 0's elevation, else the lowest floor or room; -Infinity when the prior gives no heights. */
function groundElevationM(prior: FloorPlanPrior): number {
  const ground = prior.floors.find(floor => floor.index === 0);
  if (ground) return ground.elevationM;
  const heights = [...prior.floors.map(floor => floor.elevationM), ...prior.rooms.map(room => room.zMin)];
  return heights.length > 0 ? Math.min(...heights) : -Infinity;
}


/* Reachability: straight lines from the action's origin through free space or passable openings. */

const SEGMENT_STEP_M = 0.1;
/**
 * Opening depth. Neither the prior nor the scene metadata carries a wall thickness, so the harness derives
 * each opening's depth from the same free-space model reachability uses: along the opening's normal, on
 * each side, the distance from its centre to where free space begins (a room's interior, or exterior air
 * beyond wallClearanceM). The aperture spans exactly that gap — the wall, plus the exterior clearance band
 * the model treats as wall — instead of a fixed ±0.35 m, so a line passes only if it threads the real
 * opening. Probed in DEPTH_PROBE_STEP_M steps, at most MAX_APERTURE_DEPTH_M per side.
 */
const DEPTH_PROBE_STEP_M = 0.01;
const MAX_APERTURE_DEPTH_M = 1.0;

interface Aperture {
  readonly center: Vec3;
  readonly normal: Vec3;
  readonly tangent: Vec3;
  /** The opening's height direction: world up for a wall opening, horizontal for a floor opening. */
  readonly up: Vec3;
  readonly halfWidth: number;
  readonly halfHeight: number;
  /** Depth of the gap from the centre along +normal (outward) and along −normal (inward). */
  readonly outerDepthM: number;
  readonly innerDepthM: number;
}

const requiredCache = new WeakMap<Region, Map<string, { readonly all: readonly Vec3[]; readonly points: readonly Vec3[] }>>();

/**
 * Samples of the region plus margin that need coverage: occupiable and reachable from the action's origin.
 * `opensOpenings` lists openings the action itself opens (a breach's target window), which its own debris
 * passes through. `falling` adds reachability by a vertical drop.
 *
 * Samples inside the region are reached from its origin. Samples only in the coverage margin around it are
 * reached from `marginOrigin` when given (default: the same origin). A breach passes its standoff: shards
 * travel away from the striker, so they cannot turn round the frame into the pocket beside it that the
 * wall shields from the striker's side, while every sample of the debris region itself still counts.
 * Memoized per region, fall mode, margin origin and
 * opening-state signature, since monitoring re-checks the same region every tick.
 */
export function requiredSamples(region: Region, ctx: HarnessContext, opensOpenings: readonly string[] = [], falling = false, marginOrigin?: Vec3): { readonly all: readonly Vec3[]; readonly points: readonly Vec3[] } {
  const { policy } = ctx;
  const prior = ctx.belief.mapPrior;
  const passable = [...new Set([...passableOpeningIds(ctx), ...opensOpenings])].sort();
  const marginKey = marginOrigin ? `${marginOrigin.x},${marginOrigin.y},${marginOrigin.z}` : "-";
  // The sampling parameters are part of the key, not only the policy revision: a context may carry an
  // adjusted policy under the same revision (tests, experiments), and stale samples must never be reused.
  const sampling = `${policy.coverageMarginM},${policy.coverageSpacingM},${policy.wallClearanceM},${ctx.profile.spanM}`;
  const signature = `${prior.revision}|${policy.revision}|${sampling}|${falling ? "fall" : "line"}|${marginKey}|${passable.join(",")}`;
  let byRegion = requiredCache.get(region);
  if (!byRegion) {
    byRegion = new Map();
    requiredCache.set(region, byRegion);
  }
  const cached = byRegion.get(signature);
  if (cached) return cached;
  const origin = originPoint(region);
  const isOccupiable = occupancyFilter(prior, policy.wallClearanceM, origin.z);
  const isFree = freeSpaceFilter(prior, policy.wallClearanceM);
  const openings = apertures(ctx, passable, isFree);
  // coverageMarginM, not personMarginM: coverage needs the region itself searched (plus a thin edge band);
  // a person nearby is the detection rule's job, with the wider margin, every tick (see policy.ts).
  const all = samplePoints(region, policy.coverageSpacingM, policy.coverageMarginM);
  const reachesFrom = (from: Vec3, point: Vec3): boolean => reachable(from, point, isFree, openings) || (falling && reachableByDrop(from, point, isFree, openings));
  const reaches = (point: Vec3): boolean => reachesFrom(marginOrigin && !regionContains(region, point) ? marginOrigin : origin, point);
  const outsideJet = outsideJetReach(region, falling, ctx.profile.spanM / 2 + AIRFRAME_BAND_M);
  const points = all.filter(point => isOccupiable(point) && reaches(point) && !outsideJet(point));
  const result = { all, points };
  byRegion.set(signature, result);
  return result;
}

/**
 * For a water jet (a sector from the nozzle, nothing falling), whether an edge-band sample lies where the water
 * cannot go: behind the nozzle's plane (water leaves the nozzle forward; splash-back is not modelled), or
 * within the airframe's radius plus AIRFRAME_BAND_M of the nozzle, where the jet is still only centimetres wide and
 * the band is the aircraft's own body and the air against it, beside, above and below the airframe where no
 * forward or downward camera looks. Such samples need no search. Samples inside the region itself are always
 * kept, and a person detected near the region still blocks it under the 1 m person margin.
 */
/** Air against the airframe, around the nozzle, that no camera sees and the jet does not reach. */
export const AIRFRAME_BAND_M = 0.3;

function outsideJetReach(region: Region, falling: boolean, nearNozzleM: number): (point: Vec3) => boolean {
  if (falling || region.kind !== "sector") return () => false;
  const { apex, axis } = region;
  return point => {
    if (regionContains(region, point)) return false;
    const offset = sub(point, apex);
    return dot(offset, axis) < 0 || Math.hypot(offset.x, offset.y, offset.z) <= nearNozzleM;
  };
}

/** Openings water or debris can pass: any not last observed closed or blocked (unobserved counts as passable). */
function passableOpeningIds(ctx: HarnessContext): string[] {
  const latest = new Map<string, { tick: number; state: string }>();
  for (const evidence of ctx.belief.openings) {
    const current = latest.get(evidence.openingId);
    if (!current || evidence.tick >= current.tick) latest.set(evidence.openingId, { tick: evidence.tick, state: evidence.state });
  }
  return ctx.belief.mapPrior.openings
    .filter(opening => {
      const state = latest.get(opening.id)?.state;
      return state !== "closed" && state !== "blocked";
    })
    .map(opening => opening.id)
    .sort();
}

function apertures(ctx: HarnessContext, passableIds: readonly string[], isFree: (point: Vec3) => boolean): Aperture[] {
  const passable = new Set(passableIds);
  return ctx.belief.mapPrior.openings
    .filter(opening => passable.has(opening.id))
    .map(opening => {
      const n = opening.outwardNormal;
      const wall = Math.hypot(n.x, n.y) > 1e-6;
      const normal = wall ? normalize(vec3(n.x, n.y, 0)) : vec3(0, 0, 1);
      const depth = (sign: number): number => gapDepthM(opening.center, normal, sign, isFree);
      if (wall) {
        return { center: opening.center, normal, tangent: vec3(-normal.y, normal.x, 0), up: vec3(0, 0, 1), halfWidth: opening.widthM / 2, halfHeight: opening.heightM / 2, outerDepthM: depth(1), innerDepthM: depth(-1) };
      }
      // A floor opening (a stairwell): its normal is vertical and the prior does not say which way its width
      // runs, so both horizontal half-extents take the larger dimension (more passable, so more coverage required).
      const half = Math.max(opening.widthM, opening.heightM) / 2;
      return { center: opening.center, normal, tangent: vec3(1, 0, 0), up: vec3(0, 1, 0), halfWidth: half, halfHeight: half, outerDepthM: depth(1), innerDepthM: depth(-1) };
    });
}

/** Distance from the opening's centre along sign × normal to the first free-space point beyond it, plus one probe step (the centre itself may lie on a room boundary). */
function gapDepthM(center: Vec3, normal: Vec3, sign: number, isFree: (point: Vec3) => boolean): number {
  for (let d = DEPTH_PROBE_STEP_M; d <= MAX_APERTURE_DEPTH_M; d += DEPTH_PROBE_STEP_M) {
    if (isFree(vec3(center.x + sign * normal.x * d, center.y + sign * normal.y * d, center.z + sign * normal.z * d))) return d + DEPTH_PROBE_STEP_M;
  }
  return MAX_APERTURE_DEPTH_M;
}

/** Air a jet or debris can cross: inside any room (on any level) or exterior air clear of walls. */
function freeSpaceFilter(prior: FloorPlanPrior, wallClearanceM: number): (point: Vec3) => boolean {
  const volumes = prior.rooms.filter(room => room.polygon.length >= 3).map(room => prism(room.polygon, room.zMin, room.zMax));
  const columns = prior.rooms.filter(room => room.polygon.length >= 3).map(room => prism(room.polygon, -Infinity, Infinity));
  const groundZ = groundElevationM(prior);
  return point => volumes.some(volume => regionContains(volume, point))
    || (point.z >= groundZ && columns.every(column => distanceToRegion(column, point) > wallClearanceM));
}

function insideAperture(point: Vec3, aperture: Aperture): boolean {
  const d = sub(point, aperture.center);
  const along = dot(d, aperture.normal);
  return Math.abs(dot(d, aperture.tangent)) <= aperture.halfWidth
    && Math.abs(dot(d, aperture.up)) <= aperture.halfHeight
    && along <= aperture.outerDepthM && along >= -aperture.innerDepthM;
}

/** Every interior sample of the segment lies in free space or inside a passable opening's aperture. */
function reachable(origin: Vec3, target: Vec3, isFree: (point: Vec3) => boolean, openings: readonly Aperture[]): boolean {
  const delta = sub(target, origin);
  const lengthM = Math.hypot(delta.x, delta.y, delta.z);
  const steps = Math.ceil(lengthM / SEGMENT_STEP_M);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const point = vec3(origin.x + delta.x * t, origin.y + delta.y * t, origin.z + delta.z * t);
    if (!isFree(point) && !openings.some(aperture => insideAperture(point, aperture))) return false;
  }
  return true;
}

/** Below the origin, the point above the sample at the origin's height is reachable and the vertical drop to the sample is free. */
function reachableByDrop(origin: Vec3, target: Vec3, isFree: (point: Vec3) => boolean, openings: readonly Aperture[]): boolean {
  if (!(target.z < origin.z)) return false;
  const top = vec3(target.x, target.y, origin.z);
  const clear = (point: Vec3): boolean => isFree(point) || openings.some(aperture => insideAperture(point, aperture));
  return clear(top) && reachable(origin, top, isFree, openings) && reachable(top, target, isFree, openings);
}

/**
 * Where the intervention originates: a spray sector's apex (the nozzle), a debris or release sphere's
 * centre; for a union (a sphere with its fall columns) the origin of its first part.
 */
function originPoint(region: Region): Vec3 {
  if (region.kind === "sector") return region.apex;
  if (region.kind === "sphere") return region.center;
  if (region.kind === "union") return originPoint(region.parts[0]);
  return representativePoint(region);
}
