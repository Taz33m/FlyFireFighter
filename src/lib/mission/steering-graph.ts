/**
 * Flight paths through the floor-plan prior (truth-free): which straight legs connect the aircraft's
 * estimated position to a harness goal through rooms, openings, stairs and around the building.
 *
 * Nodes: a portal point portalOffsetM on each side of every passable opening (the leg between them passes
 * through the opening's centre along its normal), each staircase's ends at hover height, inset nodes at the
 * reflex corners of non-convex rooms, four corners around the building's footprint, the start and the goal.
 * Legs join nodes in the same space (a room or the exterior) when every sample stays inside the room's
 * polygon, or, outside, clear of every room's footprint. The start and goal may also join the far portal
 * of an adjacent opening when the leg passes through its aperture with the aircraft's clearance.
 *
 * Passability comes only from opening evidence and the prior: a window is passable once observed broken or
 * open; a door or opening is passable when last observed open/broken, or unobserved with an open prior
 * state. Nothing here reads simulator truth.
 *
 * Fire. No leg may pass within fireClearanceM of a burning fire's observed region, nor through the hot column
 * above it (the region raised by up to fireColumnM, then the same clearance): measured in the staged spray
 * run, a leg that merely cost extra near a fresh fire flew straight over the hall fire at 0.6 m above the
 * floor, the ambient read 99 °C and the run ended in a terminal descent over the fire. A fire counts as burning
 * from any intensity > 0 observation in the evidence window until a later intensity-0 observation at the same
 * place reports it out (not only while it is in view). A start inside the clearance (a pose that drifted in)
 * may leave as long as each metre takes it fireDepartureSlope farther out; a goal on the clearance's boundary
 * (a spray standoff, which the planner keeps 0.8 + 0.2 m from the fire) may be approached over its last
 * fireGoalGraceM no closer than itself; a goal deeper inside has no path (see clearOfFires). When no leg set
 * avoids the fires the search reports no path rather than flying past one.
 *
 * Wall clearance. Inside a room the prior's polygon is the wall face, so a leg that merely stays inside it
 * can graze a wall or clip a door jamb (measured on Troy: replanned from a pose in the rear-bedroom doorway,
 * the direct leg to the next hall node ran diagonally past the jamb corner and the aircraft struck it at
 * 0.06 m/s; a diagonal leg into the bedroom passed the other jamb with 3 cm to spare). The search therefore
 * first requires every room leg to keep clearanceM from every wall (the polygon's edges less the spans of
 * passable openings in them) and charges wallPenaltyM in proportion to any shortfall from clearanceM +
 * wallMarginM, so it prefers a centred line when that costs little. Openings are then crossed only along their
 * normal: portal to portal, or from the start (or to the goal) through a node at the opening's centre, so a
 * pose in a doorway first re-centres in it and a diagonal through a door is never planned. Within
 * endpointWallGraceM of an endpoint that itself sits closer to a wall (a standoff beside a window, a pose in a
 * doorway) a leg may come as close as that endpoint, never closer. Only when that search finds no path does
 * the original rule (inside the polygon, aperture centre clearance) apply, so a goal the prior connects is
 * never reported unreachable because of the margin. Furniture is not in the prior; the reflexes and range
 * assistance remain responsible for it.
 */
import type { Tick } from "../contracts/clock.ts";
import type { FloorPlanPrior, HazardEvidence, OpeningEvidence } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance, vec3 } from "../contracts/frames.ts";
import type { Bounds, Point2 } from "../contracts/geometry.ts";
import { distanceToRegion, expandBounds, pointInPolygon, polygonArea, regionBounds, representativePoint } from "../contracts/geometry.ts";

export const STEERING = Object.freeze({
  portalOffsetM: 1.0,
  stairHoverM: 1.2,
  /** A start or goal over a stair, from stairFloorM above its treads to stairLineM above its hover line, is on that stair. */
  stairLineM: 1.5,
  stairFloorM: 0.35,
  roomHoverM: 1.4,
  reflexInsetM: 0.6,
  footprintMarginM: 2.5,
  exteriorClearanceM: 0.6,
  /** Exterior clearance is not required within this distance of a leg's start or goal end. */
  endpointGraceM: 0.8,
  sampleStepM: 0.25,
  /** Horizontal and slant clearance from a burning fire's observed region (≥ the planner's 0.8 + 0.2 m spray-standoff clearance). */
  fireClearanceM: 1.0,
  /** The hot column: the clearance also applies to the region raised by up to this much. */
  fireColumnM: 1.5,
  /** Near an endpoint inside a fire's clearance, the requirement grows from its own distance at this rate per metre... */
  fireDepartureSlope: 0.5,
  /** ...less this allowance, so a start inside the region or its hot column can still leave along a sampled leg. */
  fireDepartureAllowanceM: 0.15,
  /** A goal may lie this much inside the fire clearance (a standoff on its boundary); a deeper goal has no path. */
  fireGoalToleranceM: 0.1,
  /** Within this distance of such a goal a leg may come as close as the goal less fireDepartureAllowanceM (the final approach). */
  fireGoalGraceM: 1.5,
  /** A fire observed out (intensity 0) within this distance of an earlier sighting supersedes it. */
  fireSameM: 0.75,
  /** Preferred wall clearance on top of the query's clearance: a shortfall costs up to wallPenaltyM per leg. */
  wallMarginM: 0.1,
  wallPenaltyM: 2,
  /** Within this distance of an endpoint closer to a wall than required, a leg may come as close as that endpoint. */
  endpointWallGraceM: 0.6,
  /** Assumed half-depth of the wall an opening sits in: a leg to the opening's centre may run inside this slot. */
  wallHalfDepthM: 0.1,
});

/** One search tier: wall clearance for room legs (0 = inside the polygon only) and whether the start or goal may cross an opening on a direct leg. */
interface Tier {
  readonly wallM: number;
  readonly directCrossing: boolean;
}

/** Wall pieces of a room: its polygon edges less the spans of passable openings in them. */
type Walls = ReadonlyMap<string, readonly (readonly [Point2, Point2])[]>;

export const EXTERIOR = "exterior";

export interface PathQuery {
  readonly prior: FloorPlanPrior;
  readonly openings: readonly OpeningEvidence[];
  readonly hazards: readonly HazardEvidence[];
  readonly tick: Tick;
  readonly from: Vec3;
  readonly goal: Vec3;
  /** Half the aircraft's span plus a margin: the clearance an aperture crossing must leave on every side. */
  readonly clearanceM: number;
}

export interface FlightPath {
  readonly points: readonly Vec3[];
  /** Opening or stair ids crossed, in order (for the timeline and diagnostics). */
  readonly via: readonly string[];
  readonly lengthM: number;
}

interface PathNode {
  readonly p: Vec3;
  readonly space: string;
  readonly label: string | null;
  /** The opening's centre (one node per side): joined only to its own portals and to the start or goal. */
  readonly centre?: boolean;
}

interface Aperture {
  readonly id: string;
  readonly center: Vec3;
  readonly normal: Vec3;
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly spaces: readonly [string, string];
}

type PriorRoom = FloorPlanPrior["rooms"][number];

/** The room containing p, else a room within 0.45 m horizontally at a compatible height, else the exterior. */
export function spaceOf(prior: FloorPlanPrior, p: Vec3): string {
  let best: { id: string; d: number } | null = null;
  for (const room of prior.rooms) {
    if (p.z < room.zMin - 0.2 || p.z > room.zMax + 0.2) continue;
    if (pointInPolygon(p.x, p.y, room.polygon) && p.z >= room.zMin && p.z <= room.zMax) return room.id;
    const d = polygonDistance(room.polygon, p.x, p.y);
    if (d <= 0.45 && (best === null || d < best.d)) best = { id: room.id, d };
  }
  return best?.id ?? EXTERIOR;
}

/** Shortest flight path from `from` to `goal`, or null when the prior offers no passable connection. */
export function findFlightPath(query: PathQuery): FlightPath | null {
  const { prior } = query;
  const rooms = new Map(prior.rooms.map(room => [room.id, room]));
  const apertures = passableApertures(query);
  const nodes: PathNode[] = [
    { p: query.from, space: spaceOf(prior, query.from), label: null },
    { p: query.goal, space: spaceOf(prior, query.goal), label: null },
    ...apertures.flatMap(portalNodes),
    ...apertures.flatMap(centreNodes),
    ...stairNodes(prior),
    ...reflexNodes(prior),
    ...footprintCorners(prior, Math.min(8, Math.max(1.5, query.from.z, query.goal.z))),
  ];
  const fires = burningFires(query.hazards);
  const walls = roomWalls(prior, apertures);
  const search = (tier: Tier): number[] | null => shortestPath(nodes, (a, b) => legCost(nodes, a, b, { rooms, apertures, walls, query, fires, tier }));
  // The permissive tier decides reachability; the wall-keeping tier chooses the path whenever it connects.
  const loose = search({ wallM: 0, directCrossing: true });
  if (loose === null) return null;
  const order = search({ wallM: query.clearanceM, directCrossing: false }) ?? loose;
  const points = order.map(i => nodes[i].p);
  let lengthM = 0;
  const via: string[] = [];
  for (let k = 1; k < order.length; k++) {
    lengthM += distance(points[k - 1], points[k]);
    const crossed = legLabel(nodes[order[k - 1]], nodes[order[k]], apertures);
    if (crossed !== null && via[via.length - 1] !== crossed) via.push(crossed);
  }
  return { points, via, lengthM };
}

/** The opening or stair a leg crosses: its own portal pair or stair, or the aperture a direct leg passes through. */
function legLabel(na: PathNode, nb: PathNode, apertures: readonly Aperture[]): string | null {
  if (na.label !== null && na.label === nb.label) return na.label;
  if (na.space === nb.space) return null;
  return apertures.find(ap => crossesAperture(na, nb, ap, 0))?.id ?? null;
}

/** Node indices from the start (0) to the goal (1), or null when the goal is unreachable. */
function shortestPath(nodes: readonly PathNode[], cost: (a: number, b: number) => number): number[] | null {
  const n = nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const previous = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[0] = 0;
  for (let iteration = 0; iteration < n; iteration++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] === Infinity || u === 1) break;
    done[u] = 1;
    for (let v = 0; v < n; v++) {
      if (done[v] || v === u) continue;
      const c = cost(u, v);
      if (dist[u] + c < dist[v]) {
        dist[v] = dist[u] + c;
        previous[v] = u;
      }
    }
  }
  if (dist[1] === Infinity) return null;
  const order: number[] = [];
  for (let at = 1; at >= 0; at = previous[at]) order.unshift(at);
  return order;
}

/* Nodes. */

function passableApertures(query: PathQuery): Aperture[] {
  const latest = new Map<string, OpeningEvidence>();
  for (const evidence of query.openings) {
    const known = latest.get(evidence.openingId);
    if (known === undefined || evidence.tick >= known.tick) latest.set(evidence.openingId, evidence);
  }
  return query.prior.openings.flatMap(opening => {
    const h = Math.hypot(opening.outwardNormal.x, opening.outwardNormal.y);
    if (h < 1e-6) return [];
    const observed = latest.get(opening.id)?.state;
    const state = observed ?? opening.priorState;
    const passable = opening.kind === "window" ? observed === "broken" || observed === "open" : state === "open" || state === "broken";
    if (!passable) return [];
    const normal = vec3(opening.outwardNormal.x / h, opening.outwardNormal.y / h, 0);
    return [{ id: opening.id, center: opening.center, normal, halfWidth: opening.widthM / 2, halfHeight: opening.heightM / 2, spaces: [opening.rooms[0], opening.rooms[1]] as const }];
  });
}

function portalNodes(a: Aperture): PathNode[] {
  const d = STEERING.portalOffsetM;
  return [
    { p: vec3(a.center.x - a.normal.x * d, a.center.y - a.normal.y * d, a.center.z), space: a.spaces[0], label: a.id },
    { p: vec3(a.center.x + a.normal.x * d, a.center.y + a.normal.y * d, a.center.z), space: a.spaces[1], label: a.id },
  ];
}

/** A link to an opening's centre node: only from a start or goal within portalOffsetM of that centre. */
function centreLinkAllowed(na: PathNode, nb: PathNode, endpoint: boolean): boolean {
  const centre = na.centre === true ? na : nb;
  const end = na.centre === true ? nb : na;
  return endpoint && Math.hypot(end.p.x - centre.p.x, end.p.y - centre.p.y) <= STEERING.portalOffsetM;
}

/** A start or goal on a stair's flight line continues along that stair to either of its end nodes. */
function joinsStair(na: PathNode, nb: PathNode, a: number, b: number, prior: FloorPlanPrior): boolean {
  if (a <= 1) return onStairOf(na, nb, prior);
  return b <= 1 && onStairOf(nb, na, prior);
}

/**
 * True when `end` (the start or goal) lies on the flight line of the stair whose end node is `node`: between the
 * stair's ends, within half its width of the line, and from stairFloorM above the treads to stairLineM above the
 * hover height there. Replanned from partway down a stair, the path continues to the bottom instead of climbing
 * back to the top node (measured on Troy: the follower replans every second, and each replan sent the aircraft
 * back up for 15 s); climbing, the aircraft tracks above the hover line (its pursuit target is ahead and above),
 * and at 0.87 m above it a 0.8 m window sent it back down to the bottom node.
 */
function onStairOf(end: PathNode, node: PathNode, prior: FloorPlanPrior): boolean {
  if (node.label === null || node.centre === true) return false;
  const stair = (prior.stairs ?? []).find(candidate => candidate.id === node.label);
  if (stair === undefined) return false;
  const dx = stair.top.x - stair.bottom.x;
  const dy = stair.top.y - stair.bottom.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return false;
  const t = ((end.p.x - stair.bottom.x) * dx + (end.p.y - stair.bottom.y) * dy) / len2;
  if (t < 0 || t > 1) return false;
  const lateral = Math.abs((end.p.x - stair.bottom.x) * -dy + (end.p.y - stair.bottom.y) * dx) / Math.sqrt(len2);
  const hover = stair.bottom.z + (stair.top.z - stair.bottom.z) * t + STEERING.stairHoverM;
  return lateral <= stair.widthM / 2 && end.p.z >= hover - STEERING.stairHoverM + STEERING.stairFloorM && end.p.z <= hover + STEERING.stairLineM;
}

/** The opening's centre, once in each of its spaces: the straight crossing for a start or goal in or near the opening. */
function centreNodes(a: Aperture): PathNode[] {
  return [{ p: a.center, space: a.spaces[0], label: a.id, centre: true }, { p: a.center, space: a.spaces[1], label: a.id, centre: true }];
}

function stairNodes(prior: FloorPlanPrior): PathNode[] {
  return (prior.stairs ?? []).flatMap(stair => [
    { p: vec3(stair.bottom.x, stair.bottom.y, stair.bottom.z + STEERING.stairHoverM), space: stair.bottomRoomId, label: stair.id },
    { p: vec3(stair.top.x, stair.top.y, stair.top.z + STEERING.stairHoverM), space: stair.topRoomId, label: stair.id },
  ]);
}

/** Inset points at reflex corners, so legs can turn the inside corner of an L-shaped room. */
function reflexNodes(prior: FloorPlanPrior): PathNode[] {
  return prior.rooms.flatMap(room => {
    const poly = room.polygon;
    const orientation = polygonArea(poly) >= 0 ? 1 : -1;
    const z = Math.min(room.zMin + STEERING.roomHoverM, room.zMax - 0.4);
    const nodes: PathNode[] = [];
    for (let i = 0; i < poly.length; i++) {
      const [px, py] = poly[(i + poly.length - 1) % poly.length];
      const [vx, vy] = poly[i];
      const [nx, ny] = poly[(i + 1) % poly.length];
      const e1 = unit2(vx - px, vy - py);
      const e2 = unit2(nx - vx, ny - vy);
      if (orientation * (e1[0] * e2[1] - e1[1] * e2[0]) >= 0) continue;
      const bx = orientation * (-e1[1] - e2[1]);
      const by = orientation * (e1[0] + e2[0]);
      const [ux, uy] = unit2(bx, by);
      const scale = STEERING.reflexInsetM * Math.SQRT2;
      const p = vec3(vx + ux * scale, vy + uy * scale, z);
      if (pointInPolygon(p.x, p.y, poly)) nodes.push({ p, space: room.id, label: null });
    }
    return nodes;
  });
}

function footprintCorners(prior: FloorPlanPrior, z: number): PathNode[] {
  const xs = prior.rooms.flatMap(room => room.polygon.map(p => p[0]));
  const ys = prior.rooms.flatMap(room => room.polygon.map(p => p[1]));
  if (xs.length === 0) return [];
  const m = STEERING.footprintMarginM;
  const [x0, x1, y0, y1] = [Math.min(...xs) - m, Math.max(...xs) + m, Math.min(...ys) - m, Math.max(...ys) + m];
  return [vec3(x0, y0, z), vec3(x1, y0, z), vec3(x1, y1, z), vec3(x0, y1, z)].map(p => ({ p, space: EXTERIOR, label: null }));
}

/**
 * Fires to keep clear of: the latest sighting of each place (sightings within fireSameM of one another) whose
 * intensity is > 0. A place whose latest sighting is of intensity 0 has been seen out.
 */
export function burningFires(hazards: readonly HazardEvidence[]): HazardEvidence[] {
  const latest: { point: Vec3; fire: HazardEvidence }[] = [];
  for (const fire of hazards.filter(h => h.hazard === "fire").sort((a, b) => b.tick - a.tick)) {
    const point = representativePoint(fire.region);
    if (!latest.some(known => distance(known.point, point) <= STEERING.fireSameM)) latest.push({ point, fire });
  }
  return latest.filter(known => known.fire.intensity > 0).map(known => known.fire);
}

/** The fire's bounds grown by the clearance, and upward by the hot column too: outside them a point is clear. */
function fireReach(fire: HazardEvidence): Bounds {
  const b = expandBounds(regionBounds(fire.region), STEERING.fireClearanceM);
  return { min: b.min, max: vec3(b.max.x, b.max.y, b.max.z + STEERING.fireColumnM) };
}

/** Whether the segment's own bounding box meets the box (a cheap test before sampling). */
function segmentNearBox(p: Vec3, q: Vec3, b: Bounds): boolean {
  return Math.min(p.x, q.x) <= b.max.x && Math.max(p.x, q.x) >= b.min.x && Math.min(p.y, q.y) <= b.max.y && Math.max(p.y, q.y) >= b.min.y && Math.min(p.z, q.z) <= b.max.z && Math.max(p.z, q.z) >= b.min.z;
}

/** Distance from p to the nearest fire's region or the hot column above it (Infinity without fires). */
export function fireDistance(fires: readonly HazardEvidence[], p: Vec3): number {
  let best = Infinity;
  for (const fire of fires) {
    for (let h = 0; h <= STEERING.fireColumnM + 1e-9; h += 0.25) best = Math.min(best, distanceToRegion(fire.region, vec3(p.x, p.y, p.z - h)));
  }
  return best;
}

/**
 * True when the straight segment p → q keeps the fire clearance: every 0.25 m sample at least fireClearanceM
 * from the fires (and their hot columns). At an end that is a true start or goal (`relax`), and inside the
 * clearance, the requirement is relaxed: from a start, to its distance plus fireDepartureSlope × the distance
 * from it, less fireDepartureAllowanceM (it can always leave, never skirt); toward a goal within
 * fireGoalToleranceM of the boundary (a spray standoff), within fireGoalGraceM of it, to the goal's own
 * distance less that allowance (the final approach). Intermediate path nodes get no relaxation.
 */
export function clearOfFires(allFires: readonly HazardEvidence[], p: Vec3, q: Vec3, relax: { readonly from: boolean; readonly to: boolean } = { from: true, to: true }): boolean {
  const fires = allFires.filter(fire => segmentNearBox(p, q, fireReach(fire)));
  if (fires.length === 0) return true;
  const length = distance(p, q);
  const steps = Math.max(1, Math.ceil(length / STEERING.sampleStepM));
  // A start may be anywhere (the aircraft must be able to leave); a goal only on the clearance's boundary.
  const from = relax.from ? fireDistance(fires, p) : Infinity;
  const goalDistance = relax.to ? fireDistance(fires, q) : Infinity;
  const to = goalDistance >= STEERING.fireClearanceM - STEERING.fireGoalToleranceM ? goalDistance : Infinity;
  const slope = STEERING.fireDepartureSlope;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const along = t * length;
    const allowance = STEERING.fireDepartureAllowanceM;
    const nearGoal = length - along <= STEERING.fireGoalGraceM ? to - (i === steps ? 0 : allowance) : Infinity;
    const required = Math.min(STEERING.fireClearanceM, from + slope * along - (i === 0 ? 0 : allowance), nearGoal);
    if (fireDistance(fires, vec3(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t, p.z + (q.z - p.z) * t)) < required - 1e-9) return false;
  }
  return true;
}

/* Legs. */

interface LegContext {
  readonly rooms: ReadonlyMap<string, PriorRoom>;
  readonly apertures: readonly Aperture[];
  readonly walls: Walls;
  readonly query: PathQuery;
  readonly fires: readonly HazardEvidence[];
  readonly tier: Tier;
}

function legCost(nodes: readonly PathNode[], a: number, b: number, ctx: LegContext): number {
  const na = nodes[a];
  const nb = nodes[b];
  const length = distance(na.p, nb.p);
  const penalty = legPenalty(na, nb, a, b, ctx);
  if (penalty === Infinity) return Infinity;
  return clearOfFires(ctx.fires, na.p, nb.p, { from: a <= 1, to: b <= 1 }) ? length + penalty : Infinity;
}

/** Infinity when the leg is not allowed, else its wall-margin penalty (0 when it keeps the preferred margin). */
function legPenalty(na: PathNode, nb: PathNode, a: number, b: number, ctx: LegContext): number {
  if (na.label !== null && na.label === nb.label) return 0; // through its own opening, or along its own stair
  const endpoint = a <= 1 || b <= 1;
  if (joinsStair(na, nb, a, b, ctx.query.prior)) return 0;
  // An opening's centre joins only its own portals (above) and a start or goal. In the wall-keeping tier the start or
  // goal must be in or near the opening (re-centring there); a farther endpoint leaves through the portal, along the
  // opening's normal (measured on Troy: the leg from the front door's centre straight to the launch point left the
  // doorway at 52° to its normal and grazed the jamb). The permissive tier, which decides reachability, keeps any
  // start or goal: a portal can be unusable (Troy: the study door's hall-side portal lies inside the hall fire's
  // clearance), and with the stricter rule there every hall spray standoff was reported unreachable, so no spray was
  // offered at all (main mission at ded7b9e).
  if ((na.centre === true || nb.centre === true) && !(ctx.tier.directCrossing ? endpoint : centreLinkAllowed(na, nb, endpoint))) return Infinity;
  if (na.space === nb.space) return sameSpaceLeg(na.p, nb.p, na.space, ctx, endpoint, na.centre === true ? na.label : nb.centre === true ? nb.label : null);
  // The start and goal may cross one adjacent opening directly when the leg fits its aperture (permissive tier only).
  if (!endpoint || !ctx.tier.directCrossing) return Infinity;
  return ctx.apertures.some(ap => crossesAperture(na, nb, ap, ctx.query.clearanceM) && farSideInside(na.p, nb.p, ap, nb.space, ctx.rooms)) ? 0 : Infinity;
}

/**
 * A leg within one space: inside the room's polygon (or, outside, clear of every footprint away from its ends)
 * and, in the wall-keeping tier, clear of the walls. A leg to an opening's centre (`opening`) may run inside
 * that opening's slot and keeps the clearance from the walls of the opening's rooms. Returns Infinity when the
 * leg is not allowed, else the penalty for its shortfall from the preferred margin.
 */
function sameSpaceLeg(p: Vec3, q: Vec3, space: string, ctx: LegContext, touchesEndpoint: boolean, opening: string | null): number {
  const room = ctx.rooms.get(space);
  const length = distance(p, q);
  const steps = Math.max(1, Math.ceil(length / STEERING.sampleStepM));
  const ap = opening === null ? null : ctx.apertures.find(candidate => candidate.id === opening) ?? null;
  const ends = legEnds(p, q, ctx.tier.wallM <= 0 ? null : legWalls(room, ap, ctx.walls));
  let shortfall = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = p.x + (q.x - p.x) * t;
    const y = p.y + (q.y - p.y) * t;
    if (ends !== null) shortfall = Math.max(shortfall, wallShortfall(ends, x, y, t * length, ctx.tier.wallM));
    if (room !== undefined) {
      if (!pointInPolygon(x, y, room.polygon) && !(ap !== null && inSlot(ap, x, y))) return Infinity;
      continue;
    }
    const along = t * length;
    if (touchesEndpoint && (along < STEERING.endpointGraceM || length - along < STEERING.endpointGraceM)) continue;
    if (ctx.query.prior.rooms.some(r => polygonDistance(r.polygon, x, y) < STEERING.exteriorClearanceM)) return Infinity;
  }
  return shortfall === Infinity ? Infinity : (STEERING.wallPenaltyM * Math.min(shortfall, STEERING.wallMarginM)) / STEERING.wallMarginM;
}

interface LegEnds {
  readonly walls: readonly (readonly [Point2, Point2])[];
  /** The endpoints' own wall distances. */
  readonly from: number;
  readonly to: number;
  readonly length: number;
}

function legEnds(p: Vec3, q: Vec3, walls: readonly (readonly [Point2, Point2])[] | null): LegEnds | null {
  return walls === null ? null : { walls, from: wallDistance(walls, p.x, p.y), to: wallDistance(walls, q.x, q.y), length: distance(p, q) };
}

/** A sample's shortfall from the preferred wall margin; Infinity when it is inside the required clearance. */
function wallShortfall(ends: LegEnds, x: number, y: number, along: number, clearanceM: number): number {
  const d = wallDistance(ends.walls, x, y);
  if (d < requiredWallClearance(clearanceM, ends.from, ends.to, along, ends.length)) return Infinity;
  return requiredWallClearance(clearanceM + STEERING.wallMarginM, ends.from, ends.to, along, ends.length) - d;
}

/** Walls a leg must keep clear of: its room's, plus those of the rooms of the opening it ends in. */
function legWalls(room: PriorRoom | undefined, ap: Aperture | null, walls: Walls): readonly (readonly [Point2, Point2])[] | null {
  const ids = new Set<string>();
  if (room !== undefined) ids.add(room.id);
  if (ap !== null) for (const id of ap.spaces) if (id !== EXTERIOR) ids.add(id);
  if (ids.size === 0) return null;
  return [...ids].flatMap(id => walls.get(id) ?? []);
}

/** Inside the opening's slot through the wall: within the wall's half-depth (plus a little) of its plane and within its width. */
function inSlot(ap: Aperture, x: number, y: number): boolean {
  const along = (x - ap.center.x) * ap.normal.x + (y - ap.center.y) * ap.normal.y;
  const across = (x - ap.center.x) * -ap.normal.y + (y - ap.center.y) * ap.normal.x;
  return Math.abs(along) <= STEERING.wallHalfDepthM + 0.05 && Math.abs(across) <= ap.halfWidth;
}

/**
 * Wall clearance a sample `along` metres into a leg of `length` must keep: `clearanceM`, or within
 * endpointWallGraceM of an endpoint that is itself closer to a wall, that endpoint's own distance.
 */
export function requiredWallClearance(clearanceM: number, fromWallM: number, toWallM: number, along: number, length: number): number {
  const grace = STEERING.endpointWallGraceM;
  return Math.min(clearanceM, along <= grace ? fromWallM : Infinity, length - along <= grace ? toWallM : Infinity);
}

/** The leg crosses the opening's plane once, inside its aperture with `clearanceM` to every edge. */
function crossesAperture(na: PathNode, nb: PathNode, ap: Aperture, clearanceM: number): boolean {
  if (!(ap.spaces.includes(na.space) && ap.spaces.includes(nb.space))) return false;
  const da = (na.p.x - ap.center.x) * ap.normal.x + (na.p.y - ap.center.y) * ap.normal.y;
  const db = (nb.p.x - ap.center.x) * ap.normal.x + (nb.p.y - ap.center.y) * ap.normal.y;
  if (da * db >= 0) return false;
  const t = da / (da - db);
  const x = na.p.x + (nb.p.x - na.p.x) * t;
  const y = na.p.y + (nb.p.y - na.p.y) * t;
  const z = na.p.z + (nb.p.z - na.p.z) * t;
  const lateral = Math.abs((x - ap.center.x) * -ap.normal.y + (y - ap.center.y) * ap.normal.x);
  return lateral <= ap.halfWidth - clearanceM && Math.abs(z - ap.center.z) <= ap.halfHeight - clearanceM;
}

/** Past the opening (beyond 0.5 m from its plane), the leg stays inside the far room's polygon. */
function farSideInside(p: Vec3, q: Vec3, ap: Aperture, farSpace: string, rooms: ReadonlyMap<string, PriorRoom>): boolean {
  const room = rooms.get(farSpace);
  if (room === undefined) return true;
  const steps = Math.max(1, Math.ceil(distance(p, q) / STEERING.sampleStepM));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = p.x + (q.x - p.x) * t;
    const y = p.y + (q.y - p.y) * t;
    const offset = Math.abs((x - ap.center.x) * ap.normal.x + (y - ap.center.y) * ap.normal.y);
    const onFarSide = (farSpace === ap.spaces[1]) === ((x - ap.center.x) * ap.normal.x + (y - ap.center.y) * ap.normal.y > 0);
    if (onFarSide && offset > 0.5 && !pointInPolygon(x, y, room.polygon)) return false;
  }
  return true;
}

/* Planar helpers. */

/** Horizontal distance from (x, y) to the polygon (0 inside). */
export function polygonDistance(polygon: readonly Point2[], x: number, y: number): number {
  if (pointInPolygon(x, y, polygon)) return 0;
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[j];
    const [bx, by] = polygon[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

/** Each room's walls: its polygon edges with the spans of passable openings lying in them removed. */
function roomWalls(prior: FloorPlanPrior, apertures: readonly Aperture[]): Walls {
  const out = new Map<string, (readonly [Point2, Point2])[]>();
  for (const room of prior.rooms) {
    const pieces: (readonly [Point2, Point2])[] = [];
    const poly = room.polygon;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j];
      const b = poly[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-9) continue;
      const ux = (b[0] - a[0]) / len;
      const uy = (b[1] - a[1]) / len;
      // Opening spans along this edge: openings of this room whose centre lies on the edge's line (within the wall's thickness).
      const gaps = apertures
        .filter(ap => ap.spaces.includes(room.id) && Math.abs(ap.normal.x * uy - ap.normal.y * ux) > 0.9)
        .filter(ap => Math.abs((ap.center.x - a[0]) * -uy + (ap.center.y - a[1]) * ux) <= 0.3)
        .map(ap => {
          const s = (ap.center.x - a[0]) * ux + (ap.center.y - a[1]) * uy;
          return [s - ap.halfWidth, s + ap.halfWidth] as const;
        })
        .sort((g, h) => g[0] - h[0]);
      let start = 0;
      for (const [g0, g1] of gaps) {
        if (g0 > start) pieces.push([[a[0] + ux * start, a[1] + uy * start], [a[0] + ux * Math.min(g0, len), a[1] + uy * Math.min(g0, len)]]);
        start = Math.max(start, g1);
      }
      if (start < len) pieces.push([[a[0] + ux * start, a[1] + uy * start], b]);
    }
    out.set(room.id, pieces);
  }
  return out;
}

/** Horizontal distance from (x, y) to the nearest wall piece. */
function wallDistance(walls: readonly (readonly [Point2, Point2])[], x: number, y: number): number {
  let best = Infinity;
  for (const [[ax, ay], [bx, by]] of walls) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

function unit2(x: number, y: number): [number, number] {
  const n = Math.hypot(x, y);
  return n > 1e-12 ? [x / n, y / n] : [0, 0];
}
