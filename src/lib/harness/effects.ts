/**
 * Modeled effects of intervention actions, derived by the harness from the action and the aircraft
 * profile — never accepted from a proposer.
 *
 * The affected region is what rule H6 checks for fresh coverage and possible occupants, and what command
 * shows on the action card. Everything that leaves the aircraft falls: water lands on the floor below the
 * jet, glass debris and a released payload fall to the floor or ground under them, so each region reaches
 * down to where the prior says that is. These are simplified simulation models of a fictional aircraft: they claim no
 * validated jet, debris or delivery behavior.
 */
import type { ActionSpec } from "../contracts/actions.ts";
import type { AircraftProfile, GlassBreakerSpec, WaterModuleSpec } from "../contracts/aircraft.ts";
import type { FloorPlanPrior } from "../contracts/evidence.ts";
import { TICK_S } from "../contracts/clock.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance, dot, normalize, sub, vec3 } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import { pointInPolygon, polygonArea, prism, sector, sphere, union } from "../contracts/geometry.ts";

export type SpraySpec = Extract<ActionSpec, { readonly kind: "spray" }>;
export type BreachSpec = Extract<ActionSpec, { readonly kind: "breach_opening" }>;
export type ReleaseSpec = Extract<ActionSpec, { readonly kind: "release_payload" }>;

export const WATER_DENSITY_KG_M3 = 1000;
/** Splash margin added beyond where the jet lands (bounded by the jet range). */
export const SPRAY_RANGE_MARGIN_M = 0.5;
/** Radius of the region a released payload may land in. */
export const RELEASE_RADIUS_M = 1.0;
/** Aim points closer than this to the standoff do not define a jet direction. */
export const MIN_AIM_DISTANCE_M = 0.05;

/** Planned dose in litres: flow × duration. */
export function sprayDoseL(spray: SpraySpec): number {
  return spray.flowLps * spray.durationTicks * TICK_S;
}

/** Water discharged after `ticks` whole discharge ticks; equals the dose after durationTicks and never exceeds it. */
export function dischargedAfterTicks(spray: SpraySpec, ticks: number): number {
  return Math.min(sprayDoseL(spray), ticks * spray.flowLps * TICK_S);
}

export function nozzleAreaM2(nozzleDiameterMm: number): number {
  const radiusM = nozzleDiameterMm / 2000;
  return Math.PI * radiusM * radiusM;
}

/** Jet reaction force F = ρQ²/A in newtons (Q in m³/s, A the nozzle area in m²). */
export function jetReactionN(flowLps: number, nozzleDiameterMm: number): number {
  const flowM3s = flowLps / 1000;
  return (WATER_DENSITY_KG_M3 * flowM3s * flowM3s) / nozzleAreaM2(nozzleDiameterMm);
}

export type FloorBands = FloorPlanPrior["floors"];

/**
 * Elevation of the floor plane the jet would land on: the floor whose band contains the nozzle, else the
 * highest floor below it (e.g. ground when spraying from outside). Null when no floor is known below.
 */
export function floorBelow(z: number, floors: FloorBands): number | null {
  const containing = floors.filter(f => f.elevationM <= z + 1e-6 && f.ceilingM >= z).map(f => f.elevationM);
  const below = containing.length > 0 ? containing : floors.filter(f => f.elevationM <= z + 1e-6).map(f => f.elevationM);
  return below.length > 0 ? Math.max(...below) : null;
}

/**
 * How far the discharge sector must reach. Water does not stop at the aim point: it keeps going until it
 * lands. The cone's shallowest ray (the axis raised by the half-angle) lands farthest; the sector reaches
 * that landing distance plus a splash margin, capped at the module's jet range. When no floor is known or
 * that ray never descends, the full jet range applies.
 */
export function sprayReachM(standoff: Vec3, axis: Vec3, halfAngleRad: number, water: WaterModuleSpec, floorZ: number | null): number {
  const shallowest = Math.asin(Math.max(-1, Math.min(1, axis.z))) + halfAngleRad;
  if (floorZ === null || shallowest >= 0 || standoff.z <= floorZ) return water.rangeM;
  const landingM = (standoff.z - floorZ) / Math.sin(-shallowest);
  return Math.min(water.rangeM, landingM + SPRAY_RANGE_MARGIN_M);
}

/**
 * Discharge sector from the standoff toward the aim point; null when the aim point gives no direction.
 * Pass the prior's floors so the sector ends where water can land; without them it spans the full jet range.
 */
export function sprayRegion(spray: SpraySpec, water: WaterModuleSpec, floors?: FloorBands): Region | null {
  const reachM = distance(spray.standoff, spray.aimPoint);
  if (!(reachM >= MIN_AIM_DISTANCE_M)) return null;
  const halfAngleRad = (water.coneHalfAngleDeg * Math.PI) / 180;
  const axis = normalize(sub(spray.aimPoint, spray.standoff));
  const floorZ = floors ? floorBelow(spray.standoff.z, floors) : null;
  const rangeM = Math.max(Math.min(water.rangeM, reachM + SPRAY_RANGE_MARGIN_M), sprayReachM(spray.standoff, axis, halfAngleRad, water, floorZ));
  return sector(spray.standoff, axis, halfAngleRad, rangeM);
}

/** Vertices of the polygon that approximates a fall column's disc; it is circumscribed, so it contains the disc. */
const FALL_COLUMN_SIDES = 12;
/** Height below which a fall column adds nothing beyond the sphere above it. */
const MIN_FALL_M = 1e-6;
/** Probe distance either side of a pane used to decide which space (room or exterior) each half of the debris falls into. */
const PANE_PROBE_M = 0.5;

/** The prior's floors alone, or the whole prior (rooms tell an interior point from the exterior). */
export type FallSource = FloorBands | FloorPlanPrior;

/**
 * Where an object falling from `point` comes to rest, from the floor-plan prior only: the floor of the
 * highest prior room under the point (its polygon contains the point and its floor is at or below it),
 * else the ground (floor 0, or the lowest known floor). With the floors alone, interior and exterior cannot
 * be told apart, so the lowest floor is used: a longer fall, never a shorter one. Null when no floor or room
 * height is known.
 */
export function fallFloorZ(point: Vec3, source: FallSource | undefined): number | null {
  if (source === undefined) return null;
  const floors = isFloorBands(source) ? source : source.floors;
  const rooms = isFloorBands(source) ? [] : source.rooms;
  const under = rooms.filter(room => room.polygon.length >= 3 && room.zMin <= point.z + 1e-6 && pointInPolygon(point.x, point.y, room.polygon)).map(room => room.zMin);
  if (under.length > 0) return Math.max(...under);
  const ground = floors.find(floor => floor.index === 0);
  if (ground) return ground.elevationM;
  const heights = [...floors.map(floor => floor.elevationM), ...rooms.map(room => room.zMin)];
  return heights.length > 0 ? Math.min(...heights) : null;
}

function isFloorBands(source: FallSource): source is FloorBands {
  return Array.isArray(source);
}

/** Circumscribed polygon of the disc (or, with a direction, the half-disc on that side), counter-clockwise. */
function discPolygon(center: Vec3, radiusM: number, towardRad: number | null): [number, number][] {
  const vertexR = radiusM / Math.cos(Math.PI / FALL_COLUMN_SIDES);
  const step = (2 * Math.PI) / FALL_COLUMN_SIDES;
  const angles = towardRad === null
    ? Array.from({ length: FALL_COLUMN_SIDES }, (_, i) => i * step)
    : Array.from({ length: FALL_COLUMN_SIDES / 2 + 1 }, (_, i) => towardRad - Math.PI / 2 + i * step);
  // A half-disc closes along its diameter: its first and last vertices lie on the line through the centre.
  return angles.map(a => [center.x + vertexR * Math.cos(a), center.y + vertexR * Math.sin(a)] as [number, number]);
}

/** The vertical column a falling object sweeps from `top` down to `floorZ`; null when there is no fall. */
function fallColumn(top: Vec3, radiusM: number, floorZ: number | null, towardRad: number | null = null): Region | null {
  if (floorZ === null || !(top.z - floorZ > MIN_FALL_M)) return null;
  return prism(discPolygon(top, radiusM, towardRad), floorZ, top.z);
}

/** Half-angle of the inward debris cone: shards struck from outside travel inward in the strike direction. */
export const BREACH_DEBRIS_HALF_ANGLE_RAD = Math.PI / 4;
/** The exterior fall strip extends this far past each side of the window frame along the facade. */
export const BREACH_STRIP_SIDE_M = 0.3;
/** The exterior fall strip reaches this far out from the wall. */
export const BREACH_STRIP_DEPTH_M = 0.6;
/** Arc segments of the fan polygon under the debris cone; circumscribed, so it contains the cone's horizontal fan. */
const FAN_SEGMENTS = 6;

/**
 * Glass debris from a strike on a pane (simplified model; no validated debris behaviour is claimed):
 *   1. an inward spherical sector at the strike point: axis along the window's inward normal (the reverse of
 *      its outward normal for a window to the exterior; for an interior opening, the strike direction from
 *      the standoff), half-angle 45°, range debrisRadiusM;
 *   2. the interior fall volume under that sector: the sector's horizontal fan extruded from the floor of
 *      the room behind the pane up to the pane's top;
 *   3. the fall strip outside along the facade: the window's width plus 0.3 m each side, 0.6 m out from the
 *      wall, from the ground (or the floor on that side) up to the pane's top — loose shards drop at the wall.
 * Without the opening in the prior (rule H14 refuses that breach anyway), the conservative fallback is a
 * debris sphere plus a full fall column to the floor below.
 */
export function breachRegion(breach: BreachSpec, breaker: GlassBreakerSpec, source?: FallSource): Region {
  const strike = breach.strikePoint;
  const radiusM = breaker.debrisRadiusM;
  const opening = source === undefined || isFloorBands(source) ? undefined : source.openings.find(o => o.id === breach.openingId);
  const outward = opening ? normalize(vec3(opening.outwardNormal.x, opening.outwardNormal.y, 0)) : null;
  if (!opening || !outward || !(Math.hypot(outward.x, outward.y) > 0.5)) {
    const debris = sphere(strike, radiusM);
    const column = fallColumn(strike, radiusM, fallFloorZ(strike, source));
    return column ? union([debris, column]) : debris;
  }
  const struckFromOutside = opening.rooms[1] === "exterior" || dot(sub(strike, breach.standoff), outward) < 0;
  const inward = struckFromOutside ? vec3(0 - outward.x, 0 - outward.y, 0) : outward;
  const away = vec3(0 - inward.x, 0 - inward.y, 0);
  const topZ = Math.max(opening.center.z + opening.heightM / 2, strike.z);
  const parts: Region[] = [sector(strike, inward, BREACH_DEBRIS_HALF_ANGLE_RAD, radiusM)];

  const inside = vec3(strike.x + inward.x * PANE_PROBE_M, strike.y + inward.y * PANE_PROBE_M, strike.z);
  const insideFloorZ = fallFloorZ(inside, source);
  if (insideFloorZ !== null && topZ - insideFloorZ > MIN_FALL_M) parts.push(prism(fanPolygon(strike, inward, radiusM), insideFloorZ, topZ));

  const outside = vec3(opening.center.x + away.x * PANE_PROBE_M, opening.center.y + away.y * PANE_PROBE_M, strike.z);
  const outsideFloorZ = fallFloorZ(outside, source);
  if (outsideFloorZ !== null && topZ - outsideFloorZ > MIN_FALL_M) parts.push(prism(stripPolygon(opening.center, away, opening.widthM / 2 + BREACH_STRIP_SIDE_M), outsideFloorZ, topZ));
  return union(parts);
}

/** The horizontal fan under a 45° debris cone: its apex and a circumscribed arc at the cone's range, counter-clockwise. */
function fanPolygon(apex: Vec3, axis: Vec3, radiusM: number): [number, number][] {
  const toward = Math.atan2(axis.y, axis.x);
  const step = (2 * BREACH_DEBRIS_HALF_ANGLE_RAD) / FAN_SEGMENTS;
  const vertexR = radiusM / Math.cos(step / 2);
  const arc = Array.from({ length: FAN_SEGMENTS + 1 }, (_, i) => toward - BREACH_DEBRIS_HALF_ANGLE_RAD + i * step);
  return [[apex.x, apex.y], ...arc.map((a): [number, number] => [apex.x + vertexR * Math.cos(a), apex.y + vertexR * Math.sin(a)])];
}

/** A rectangle on the wall line through `center`, `halfWidthM` either way along it and BREACH_STRIP_DEPTH_M toward `away`, counter-clockwise. */
function stripPolygon(center: Vec3, away: Vec3, halfWidthM: number): [number, number][] {
  const tangent = vec3(-away.y, away.x, 0);
  const corner = (along: number, out: number): [number, number] => [center.x + tangent.x * along + away.x * out, center.y + tangent.y * along + away.y * out];
  const ring = [corner(-halfWidthM, 0), corner(halfWidthM, 0), corner(halfWidthM, BREACH_STRIP_DEPTH_M), corner(-halfWidthM, BREACH_STRIP_DEPTH_M)];
  return polygonArea(ring) >= 0 ? ring : ring.reverse();
}

/**
 * A released payload: the sphere it may land in around the release point, plus the column it falls through
 * to the floor or ground below. A person under an aloft release point is in the way of the payload.
 */
export function releaseRegion(release: ReleaseSpec, source?: FallSource): Region {
  const point = release.releasePoint;
  const landing = sphere(point, RELEASE_RADIUS_M);
  const column = fallColumn(point, RELEASE_RADIUS_M, fallFloorZ(point, source));
  return column ? union([landing, column]) : landing;
}

/**
 * The region an intervention may physically affect. Null for non-interventions, and when the aircraft
 * lacks the module (rule H1 reports that) or a spray has no direction (rules H2 and H6 report that).
 * Pass the floor-plan prior (or at least its floors): water, debris and payloads fall until they land, and
 * the prior says where that is. The harness always passes the whole prior.
 */
export function affectedRegion(action: ActionSpec, profile: AircraftProfile, source?: FallSource): Region | null {
  switch (action.kind) {
    case "spray":
      return profile.modules.water ? sprayRegion(action, profile.modules.water, source === undefined || isFloorBands(source) ? source : source.floors) : null;
    case "breach_opening":
      return profile.modules.glassBreaker ? breachRegion(action, profile.modules.glassBreaker, source) : null;
    case "release_payload":
      return releaseRegion(action, source);
    default:
      return null;
  }
}

/**
 * The region whose observed map changes invalidate an action (rule H4): an intervention's affected region,
 * or the aircraft's clearance volume at a move goal or landing site.
 */
export function dependencyRegion(action: ActionSpec, profile: AircraftProfile, source?: FallSource): Region | null {
  const clearanceM = profile.spanM / 2 + profile.hardLimits.minObstacleClearanceM;
  if (action.kind === "move") return sphere(action.goal, clearanceM);
  if (action.kind === "land") return sphere(action.site, clearanceM);
  // A map change anywhere the jet could reach matters, not only where it lands, so a spray keeps its full range here.
  return affectedRegion(action, profile, action.kind === "spray" ? undefined : source);
}
