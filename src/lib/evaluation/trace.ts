/**
 * Per-tick truth observer for the independent evaluator.
 *
 * The final world state cannot show transient events, so the run loop calls recordTick after every
 * stepWorld. From TRUE state (whatever the estimate believed) it records:
 * - envelope-breach episodes: the aircraft position outside the approved envelope regions;
 * - peak true speed: horizontal and vertical separately (the harness limits them separately) and the
 *   3-D peak, plus the worst excess of horizontal speed over the envelope's speed ceiling;
 * - ambient temperature at the aircraft: the peak, the worst excess over the envelope's ambient ceiling and
 *   the time above the profile's warning temperature;
 * - motion after the envelope time box (endTick) that no contingency owned (LateMotionEpisode);
 * - aircraft–occupant contact: the aircraft sphere (radius spanM/2) within OCCUPANT_CONTACT_MARGIN_M of an
 *   occupant's body capsule (occupantCapsule), one episode per contact, with interruptions shorter than
 *   CONTACT_MERGE_TICKS merged (a gap flickering around the margin is one contact, not dozens);
 * - glass debris or a released payload reaching an occupant, from the glass_broken and payload_released
 *   truth events and a truth footprint of each (debrisFootprint, payloadFootprint);
 * - when endurance ran out (and whether airborne), and the extreme positions of the path (departure from
 *   the launch zone).
 * The envelope is the one in force on each tick, so a revision applies from the tick it takes effect. Like
 * the evaluator, this module reads hidden truth and must never be imported by planner, harness or evidence
 * code.
 */
import type { JsonValue } from "../contracts/canonical.ts";
import type { Tick } from "../contracts/clock.ts";
import { TICK_S } from "../contracts/clock.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import { envelopeContains } from "../contracts/envelope.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { dot, norm, normalize, sub, vec3 } from "../contracts/frames.ts";
import type { Point2, Region } from "../contracts/geometry.ts";
import { distanceToRegion, pointInPolygon, polygonArea, prism, sector, sphere, union } from "../contracts/geometry.ts";
import { droneRadiusM, isTouchedDown } from "../simulation/collisions.ts";
import { VELOCITY_TIME_CONSTANT_S } from "../simulation/dynamics.ts";
import { temperatureAt } from "../simulation/fire.ts";
import { OCCUPANT_RADIUS_M, occupantHeightM } from "../simulation/occupant-body.ts";
import { findOpening } from "../simulation/scene.ts";
import type { OccupantTruth, RuntimeOpening, SceneModel, TruthEvent, WorldState } from "../simulation/world-state.ts";

/**
 * Slack on every true-speed ceiling (hard limits, envelope speed, "moving" after the time box), m/s. The
 * harness limits the COMMANDED velocity; the true velocity follows it through the velocity loop and picks
 * up small disturbances (jet reaction, collision response, numerical error), so a reading this close to a
 * ceiling is not scored as an exceedance.
 */
export const SPEED_TOLERANCE_MPS = 0.1;
/** Gap between the aircraft sphere and an occupant's body capsule at or below which they are in contact, m. */
export const OCCUPANT_CONTACT_MARGIN_M = 0.05;
/** Contact interruptions shorter than this (0.5 s) continue the same episode. */
export const CONTACT_MERGE_TICKS = 50;
/** Glass-debris cone half-angle (inward from the strike point), as in the harness's breach model. */
export const DEBRIS_HALF_ANGLE_RAD = Math.PI / 4;
/** Fall strip along the facade on the striker's side: past each side of the frame and out from the wall, m. */
export const DEBRIS_STRIP_SIDE_M = 0.3;
export const DEBRIS_STRIP_DEPTH_M = 0.6;
/** Debris reach when the profile names no glass breaker (a strike cannot happen then), m. */
const DEFAULT_DEBRIS_RADIUS_M = 1.5;
/** A released payload's horizontal extent about its fall line (package half-width plus release scatter), m. */
export const PAYLOAD_RADIUS_M = 0.3;
/** Debris and payloads stay a hazard for their free-fall time plus this settling time, s. */
export const HAZARD_SETTLE_S = 0.5;
const GRAVITY_MPS2 = 9.81;
/** Spacing of the samples along an occupant's body axis for footprint tests, m. */
const BODY_SAMPLE_SPACING_M = 0.1;
/** Probe distance either side of a pane, to find the space each half of the debris falls into, m. */
const PANE_PROBE_M = 0.5;
const POLYGON_SIDES = 12;
const FAN_SEGMENTS = 6;

export interface BreachEpisode {
  readonly startTick: Tick;
  endTick: Tick;
  readonly position: Vec3;
}

/** The aircraft in contact with one occupant's body on consecutive recorded ticks. */
export interface OccupantContactEpisode {
  readonly occupantKey: string;
  readonly startTick: Tick;
  endTick: Tick;
  /** Smallest gap between the aircraft sphere and the body capsule, m (negative when they overlap). */
  minGapM: number;
}

/**
 * The aircraft moving (true speed above SPEED_TOLERANCE_MPS) after the envelope's endTick while no
 * contingency owned its motion. The state recorded at tick T results from the command issued at T − 1, and
 * the time box ends commands issued after endTick, so recording starts at endTick + 2. Braking is allowed
 * for a grace period (brakingGraceTicks) after the time box ends; the uncommanded descent after endurance
 * runs out is scored as exhaustion instead.
 */
export interface LateMotionEpisode {
  readonly startTick: Tick;
  endTick: Tick;
  readonly envelopeEndTick: Tick;
  peakSpeedMps: number;
}

/** Glass debris or a released payload reaching an occupant (once per source event and occupant). */
export interface HazardContact {
  readonly tick: Tick;
  readonly kind: "glass_debris" | "payload";
  /** Tick of the glass_broken or payload_released truth event. */
  readonly sourceTick: Tick;
  readonly occupantKey: string;
  readonly proposalId: string;
  /** The broken opening or the released payload. */
  readonly subject: string;
}

/** A debris or payload footprint still falling or settling. */
export interface ActiveHazard {
  readonly kind: HazardContact["kind"];
  readonly sourceTick: Tick;
  readonly untilTick: Tick;
  readonly region: Region;
  readonly proposalId: string;
  readonly subject: string;
  readonly hitKeys: string[];
}

/** The tick on which a reading exceeded its ceiling by the most, with both values. */
export interface CeilingPeak {
  readonly tick: Tick;
  readonly value: number;
  readonly ceiling: number;
}

export interface MissionTrace {
  readonly runId: string;
  lastTick: Tick | null;
  readonly envelopeBreaches: BreachEpisode[];
  /** Peak 3-D true speed (reported; the limits are scored on the horizontal and vertical peaks). */
  maxSpeedMps: number;
  maxSpeedTick: Tick | null;
  maxHorizontalSpeedMps: number;
  maxHorizontalSpeedTick: Tick | null;
  /** Peak |vertical true speed|. */
  maxVerticalSpeedMps: number;
  maxVerticalSpeedTick: Tick | null;
  /** Horizontal true speed against the envelope's speed ceiling, at its largest excess. */
  envelopeSpeedPeak: CeilingPeak | null;
  maxAmbientC: number;
  maxAmbientTick: Tick | null;
  /** Ambient at the aircraft against the envelope's ambient ceiling, at its largest excess. */
  envelopeAmbientPeak: CeilingPeak | null;
  /** Total time with ambient above the profile's warning temperature, s. */
  secondsAboveWarn: number;
  /** First tick at which the time above the warning temperature exceeded the profile's allowance. */
  warnExposureExceededTick: Tick | null;
  enduranceExhaustedTick: Tick | null;
  /** Whether the aircraft was airborne (not touched down) when endurance ran out: a forced descent followed. */
  enduranceExhaustedAirborne: boolean | null;
  readonly lateMotion: LateMotionEpisode[];
  readonly occupantContacts: OccupantContactEpisode[];
  readonly hazardContacts: HazardContact[];
  activeHazards: ActiveHazard[];
  /** Number of world.truthEvents already examined for debris and payload hazards. */
  truthEventsSeen: number;
  /** True positions reaching the minimum and maximum x, y and z of the recorded path (empty before the first tick). */
  readonly pathExtremes: Vec3[];
  /** True speed on the previous recorded tick. */
  previousSpeedMps: number | null;
}

/** Who owned the aircraft's motion on the recorded tick (from the run loop's harness state). */
export interface TickContext {
  /** A harness contingency (return, hold, land, or the terminal brake-and-descend) owned the motion. Omitted: none did. */
  readonly contingencyActive?: boolean;
}

export function createMissionTrace(world: WorldState): MissionTrace {
  return {
    runId: world.runId, lastTick: null, envelopeBreaches: [],
    maxSpeedMps: 0, maxSpeedTick: null, maxHorizontalSpeedMps: 0, maxHorizontalSpeedTick: null, maxVerticalSpeedMps: 0, maxVerticalSpeedTick: null,
    envelopeSpeedPeak: null, maxAmbientC: -Infinity, maxAmbientTick: null, envelopeAmbientPeak: null,
    secondsAboveWarn: 0, warnExposureExceededTick: null, enduranceExhaustedTick: null, enduranceExhaustedAirborne: null,
    lateMotion: [], occupantContacts: [], hazardContacts: [], activeHazards: [], truthEventsSeen: 0, pathExtremes: [], previousSpeedMps: null,
  };
}

/**
 * Records the world as it stands after a step (world.tick), under the envelope in force. Ticks must
 * increase; a gap splits episodes. Truth events not yet examined are examined now, whatever their tick.
 */
export function recordTick(trace: MissionTrace, world: WorldState, envelope: MissionEnvelope, context: TickContext = {}): void {
  if (world.runId !== trace.runId) throw new Error(`Trace for run ${trace.runId} cannot record run ${world.runId}.`);
  if (trace.lastTick !== null && world.tick <= trace.lastTick) throw new RangeError(`Trace tick ${world.tick} does not advance past ${trace.lastTick}.`);
  const tick = world.tick;
  const drone = world.drone;
  if (!envelopeContains(envelope, drone.position)) {
    const last = trace.envelopeBreaches[trace.envelopeBreaches.length - 1];
    if (last && continues(trace, last.endTick, tick)) last.endTick = tick;
    else trace.envelopeBreaches.push({ startTick: tick, endTick: tick, position: { ...drone.position } });
  }
  recordSpeed(trace, world, envelope, tick, context);
  recordHeat(trace, world, envelope, tick);
  recordContacts(trace, world, tick);
  recordHazards(trace, world, tick);
  recordExtremes(trace, drone.position);
  if (drone.enduranceRemainingS <= 0 && trace.enduranceExhaustedTick === null) {
    trace.enduranceExhaustedTick = tick;
    trace.enduranceExhaustedAirborne = !isTouchedDown(world);
  }
  trace.lastTick = tick;
}

/** True when an episode last extended on `endTick` continues on `tick` (the previous recorded tick, with no gap). */
function continues(trace: MissionTrace, endTick: Tick, tick: Tick): boolean {
  return trace.lastTick !== null && endTick === trace.lastTick && tick === trace.lastTick + 1;
}

/** Time to brake from the profile's maximum speed at its maximum acceleration, plus three velocity-loop time constants, in ticks. */
export function brakingGraceTicks(world: WorldState): number {
  const limits = world.profile.hardLimits;
  return Math.ceil((limits.maxSpeedMps / limits.maxAccelMps2 + 3 * VELOCITY_TIME_CONSTANT_S) / TICK_S);
}

function recordSpeed(trace: MissionTrace, world: WorldState, envelope: MissionEnvelope, tick: Tick, context: TickContext): void {
  const v = world.drone.velocity;
  const speed = norm(v);
  const horizontal = Math.hypot(v.x, v.y);
  const vertical = Math.abs(v.z);
  if (speed > trace.maxSpeedMps) [trace.maxSpeedMps, trace.maxSpeedTick] = [speed, tick];
  if (horizontal > trace.maxHorizontalSpeedMps) [trace.maxHorizontalSpeedMps, trace.maxHorizontalSpeedTick] = [horizontal, tick];
  if (vertical > trace.maxVerticalSpeedMps) [trace.maxVerticalSpeedMps, trace.maxVerticalSpeedTick] = [vertical, tick];
  trace.envelopeSpeedPeak = worse(trace.envelopeSpeedPeak, { tick, value: horizontal, ceiling: envelope.maxSpeedMps });

  const previous = trace.lastTick === tick - 1 ? trace.previousSpeedMps : null;
  trace.previousSpeedMps = speed;
  if (tick <= envelope.endTick + 1 || context.contingencyActive === true || world.drone.enduranceRemainingS <= 0 || speed <= SPEED_TOLERANCE_MPS) return;
  const braking = tick - envelope.endTick <= brakingGraceTicks(world) && previous !== null && speed < previous;
  if (braking) return;
  const last = trace.lateMotion[trace.lateMotion.length - 1];
  if (last && last.envelopeEndTick === envelope.endTick && continues(trace, last.endTick, tick)) {
    last.endTick = tick;
    last.peakSpeedMps = Math.max(last.peakSpeedMps, speed);
  } else {
    trace.lateMotion.push({ startTick: tick, endTick: tick, envelopeEndTick: envelope.endTick, peakSpeedMps: speed });
  }
}

function worse(peak: CeilingPeak | null, reading: CeilingPeak): CeilingPeak {
  return peak === null || reading.value - reading.ceiling > peak.value - peak.ceiling ? reading : peak;
}

function recordHeat(trace: MissionTrace, world: WorldState, envelope: MissionEnvelope, tick: Tick): void {
  const limits = world.profile.hardLimits;
  const ambient = temperatureAt(world, world.drone.position);
  if (ambient > trace.maxAmbientC) [trace.maxAmbientC, trace.maxAmbientTick] = [ambient, tick];
  trace.envelopeAmbientPeak = worse(trace.envelopeAmbientPeak, { tick, value: ambient, ceiling: envelope.ambientCeilingC });
  if (ambient <= limits.warnAmbientC) return;
  trace.secondsAboveWarn += TICK_S;
  if (trace.secondsAboveWarn > limits.maxExposureAboveWarnS && trace.warnExposureExceededTick === null) trace.warnExposureExceededTick = tick;
}

/* Occupant bodies. */

/**
 * An occupant's body as a vertical capsule of radius OCCUPANT_RADIUS_M whose height follows the posture
 * (standing 1.7 m, crouched 1.0 m, lying 0.4 m) above the feet point: the axis runs from one radius above
 * the feet to one radius below the top (a point at mid-height when the body is shorter than two radii).
 * A lying person is modeled as the same vertical shape: a simplification.
 */
export function occupantCapsule(o: Pick<OccupantTruth, "position" | "activity" | "animation">): { readonly bottom: Vec3; readonly top: Vec3; readonly radiusM: number } {
  const height = occupantHeightM(o);
  const p = o.position;
  const bottomZ = p.z + Math.min(OCCUPANT_RADIUS_M, height / 2);
  const topZ = p.z + Math.max(height - OCCUPANT_RADIUS_M, height / 2);
  return { bottom: vec3(p.x, p.y, bottomZ), top: vec3(p.x, p.y, topZ), radiusM: OCCUPANT_RADIUS_M };
}

/** Distance from a point to the capsule's (vertical) axis segment. */
function axisDistance(capsule: ReturnType<typeof occupantCapsule>, p: Vec3): number {
  const z = Math.max(capsule.bottom.z, Math.min(capsule.top.z, p.z));
  return Math.hypot(p.x - capsule.bottom.x, p.y - capsule.bottom.y, p.z - z);
}

/** Gap between the aircraft sphere and the occupant's body capsule, m (negative when they overlap). */
export function aircraftOccupantGapM(world: WorldState, o: OccupantTruth): number {
  const capsule = occupantCapsule(o);
  return axisDistance(capsule, world.drone.position) - capsule.radiusM - droneRadiusM(world);
}

/** True when any part of the occupant's body capsule lies in the region. */
export function bodyInRegion(o: Pick<OccupantTruth, "position" | "activity" | "animation">, region: Region): boolean {
  const { bottom, top, radiusM } = occupantCapsule(o);
  const count = Math.max(2, Math.ceil((top.z - bottom.z) / BODY_SAMPLE_SPACING_M) + 1);
  for (let i = 0; i < count; i++) {
    const z = bottom.z + ((top.z - bottom.z) * i) / (count - 1);
    if (distanceToRegion(region, vec3(bottom.x, bottom.y, z)) <= radiusM) return true;
  }
  return false;
}

function recordContacts(trace: MissionTrace, world: WorldState, tick: Tick): void {
  for (const o of world.occupants) {
    const gapM = aircraftOccupantGapM(world, o);
    if (gapM > OCCUPANT_CONTACT_MARGIN_M) continue;
    const last = findLast(trace.occupantContacts, e => e.occupantKey === o.key);
    if (last && (continues(trace, last.endTick, tick) || (tick > last.endTick && tick - last.endTick <= CONTACT_MERGE_TICKS))) {
      last.endTick = tick;
      last.minGapM = Math.min(last.minGapM, gapM);
    } else {
      trace.occupantContacts.push({ occupantKey: o.key, startTick: tick, endTick: tick, minGapM: gapM });
    }
  }
}

function findLast<T>(items: readonly T[], match: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i])) return items[i];
  return undefined;
}

/* Glass debris and released payloads. */

function recordHazards(trace: MissionTrace, world: WorldState, tick: Tick): void {
  for (; trace.truthEventsSeen < world.truthEvents.length; trace.truthEventsSeen++) {
    const hazard = hazardFromEvent(world, world.truthEvents[trace.truthEventsSeen], tick);
    if (hazard) trace.activeHazards.push(hazard);
  }
  if (trace.activeHazards.length === 0) return;
  for (const hazard of trace.activeHazards) {
    for (const o of world.occupants) {
      if (hazard.hitKeys.includes(o.key) || !bodyInRegion(o, hazard.region)) continue;
      hazard.hitKeys.push(o.key);
      trace.hazardContacts.push({ tick, kind: hazard.kind, sourceTick: hazard.sourceTick, occupantKey: o.key, proposalId: hazard.proposalId, subject: hazard.subject });
    }
  }
  // A newly examined hazard is checked at least once, even when the trace starts after it settled.
  trace.activeHazards = trace.activeHazards.filter(hazard => tick < hazard.untilTick);
}

/**
 * The truth footprint of a glass_broken or payload_released event, or null for other events. The event is
 * examined on the tick after its step when the trace is recording; then the aircraft's true position (for
 * the strike side) and velocity (for payload drift) are those of the event. Examined later (a trace started
 * late, or the final-state fallback), the strike side is unknown and both sides are covered.
 */
function hazardFromEvent(world: WorldState, event: TruthEvent, tick: Tick): ActiveHazard | null {
  const timely = tick - event.tick <= 1;
  const proposalId = String(event.data.proposalId ?? "");
  if (event.kind === "glass_broken") {
    const opening = findOpening(world.scene, String(event.data.openingId));
    if (!opening) return null;
    const strike = asVec3(event.data.point) ?? opening.center;
    const footprint = debrisFootprint(world, opening, strike, timely ? world.drone.position : null);
    return { kind: "glass_debris", sourceTick: event.tick, untilTick: event.tick + settleTicks(footprint.dropM), region: footprint.region, proposalId, subject: opening.id, hitKeys: [] };
  }
  if (event.kind === "payload_released") {
    const point = asVec3(event.data.position) ?? world.drone.position;
    const footprint = payloadFootprint(world.scene, point, timely ? Math.hypot(world.drone.velocity.x, world.drone.velocity.y) : 0);
    return { kind: "payload", sourceTick: event.tick, untilTick: event.tick + settleTicks(footprint.dropM), region: footprint.region, proposalId, subject: String(event.data.payloadId ?? "payload"), hitKeys: [] };
  }
  return null;
}

function settleTicks(dropM: number): number {
  return Math.ceil((Math.sqrt((2 * Math.max(0, dropM)) / GRAVITY_MPS2) + HAZARD_SETTLE_S) / TICK_S);
}

function asVec3(value: JsonValue | undefined): Vec3 | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { x, y, z } = value as { readonly [key: string]: JsonValue };
  return typeof x === "number" && typeof y === "number" && typeof z === "number" && Number.isFinite(x + y + z) ? vec3(x, y, z) : null;
}

/**
 * Floor an object falling at p comes to rest on, from scene truth: the floor of the highest room whose
 * polygon contains p and whose floor is at or below it, else the ground (floor 0, or the lowest floor). The
 * room floor is used even over furniture, so a fall is never shortened.
 */
export function restingFloorZ(scene: SceneModel, p: Vec3): number {
  const under = scene.rooms.filter(room => room.zMin <= p.z + 1e-6 && pointInPolygon(p.x, p.y, room.polygon)).map(room => room.zMin);
  if (under.length > 0) return Math.max(...under);
  const ground = scene.floors.find(floor => floor.index === 0);
  if (ground) return ground.elevationM;
  return scene.floors.length > 0 ? Math.min(...scene.floors.map(floor => floor.elevationM)) : 0;
}

/**
 * Truth model of glass debris (simplified; it claims no validated debris behaviour). It follows the
 * harness's breach model, but from scene truth and the aircraft's TRUE side of the pane rather than the
 * planner's prior and the commanded standoff:
 *   1. a cone at the strike point, half-angle 45°, range debrisRadiusM, pointing away from the striker
 *      (through the pane, along the opening's horizontal normal);
 *   2. the fall volume under that cone: its horizontal fan from the floor on the far side up to the pane top;
 *   3. a fall strip on the striker's side: the window width plus 0.3 m each side, 0.6 m out from the wall,
 *      from the floor on that side up to the pane top.
 * With the striker's position unknown (`striker` null), both directions are covered.
 */
export function debrisFootprint(world: WorldState, opening: RuntimeOpening, strike: Vec3, striker: Vec3 | null): { readonly region: Region; readonly dropM: number } {
  const radiusM = world.profile.modules.glassBreaker?.debrisRadiusM ?? DEFAULT_DEBRIS_RADIUS_M;
  const n = opening.outwardNormal;
  const outward = Math.hypot(n.x, n.y) > 1e-6 ? normalize(vec3(n.x, n.y, 0)) : vec3(1, 0, 0);
  const inward = vec3(-outward.x, -outward.y, 0);
  // Shards travel away from the striker: inward when it is on the outward (rooms[1]) side of the pane.
  const directions = striker === null ? [outward, inward] : [dot(sub(striker, opening.center), outward) > 0 ? inward : outward];
  const topZ = Math.max(opening.center.z + opening.heightM / 2, strike.z);
  const parts: Region[] = [];
  let lowestZ = topZ;
  for (const away of directions) {
    parts.push(sector(strike, away, DEBRIS_HALF_ANGLE_RAD, radiusM));
    const farFloorZ = restingFloorZ(world.scene, vec3(strike.x + away.x * PANE_PROBE_M, strike.y + away.y * PANE_PROBE_M, strike.z));
    if (topZ > farFloorZ) parts.push(prism(fanPolygon(strike, away, radiusM), farFloorZ, topZ));
    const back = vec3(-away.x, -away.y, 0);
    const nearFloorZ = restingFloorZ(world.scene, vec3(opening.center.x + back.x * PANE_PROBE_M, opening.center.y + back.y * PANE_PROBE_M, strike.z));
    if (topZ > nearFloorZ) parts.push(prism(stripPolygon(opening.center, back, opening.widthM / 2 + DEBRIS_STRIP_SIDE_M), nearFloorZ, topZ));
    lowestZ = Math.min(lowestZ, farFloorZ, nearFloorZ);
  }
  return { region: union(parts), dropM: topZ - lowestZ };
}

/**
 * Truth model of a released payload: it falls from the true release point to the floor or ground below,
 * sweeping a vertical column of radius PAYLOAD_RADIUS_M plus the horizontal distance the aircraft's
 * velocity at release carries it during the fall (any direction, conservatively).
 */
export function payloadFootprint(scene: SceneModel, point: Vec3, horizontalSpeedMps: number): { readonly region: Region; readonly dropM: number } {
  const floorZ = restingFloorZ(scene, point);
  const dropM = Math.max(0, point.z - floorZ);
  const radiusM = PAYLOAD_RADIUS_M + horizontalSpeedMps * Math.sqrt((2 * dropM) / GRAVITY_MPS2);
  const parcel = sphere(point, PAYLOAD_RADIUS_M);
  return { region: dropM > 1e-6 ? union([parcel, prism(discPolygon(point, radiusM), floorZ, point.z)]) : parcel, dropM };
}

/** Circumscribed polygon of a horizontal disc, counter-clockwise (it contains the disc). */
function discPolygon(center: Vec3, radiusM: number): Point2[] {
  const vertexR = radiusM / Math.cos(Math.PI / POLYGON_SIDES);
  return Array.from({ length: POLYGON_SIDES }, (_, i) => {
    const a = (i * 2 * Math.PI) / POLYGON_SIDES;
    return [center.x + vertexR * Math.cos(a), center.y + vertexR * Math.sin(a)] as const;
  });
}

/** The horizontal fan under the debris cone: its apex and a circumscribed arc at the cone's range, counter-clockwise. */
function fanPolygon(apex: Vec3, axis: Vec3, radiusM: number): Point2[] {
  const toward = Math.atan2(axis.y, axis.x);
  const step = (2 * DEBRIS_HALF_ANGLE_RAD) / FAN_SEGMENTS;
  const vertexR = radiusM / Math.cos(step / 2);
  const arc = Array.from({ length: FAN_SEGMENTS + 1 }, (_, i): Point2 => {
    const a = toward - DEBRIS_HALF_ANGLE_RAD + i * step;
    return [apex.x + vertexR * Math.cos(a), apex.y + vertexR * Math.sin(a)];
  });
  return [[apex.x, apex.y], ...arc];
}

/** A rectangle on the wall line through `center`, `halfWidthM` either way along it and DEBRIS_STRIP_DEPTH_M toward `away`, counter-clockwise. */
function stripPolygon(center: Vec3, away: Vec3, halfWidthM: number): Point2[] {
  const tangent = vec3(-away.y, away.x, 0);
  const corner = (along: number, out: number): Point2 => [center.x + tangent.x * along + away.x * out, center.y + tangent.y * along + away.y * out];
  const ring = [corner(-halfWidthM, 0), corner(halfWidthM, 0), corner(halfWidthM, DEBRIS_STRIP_DEPTH_M), corner(-halfWidthM, DEBRIS_STRIP_DEPTH_M)];
  return polygonArea(ring) >= 0 ? ring : ring.reverse();
}

function recordExtremes(trace: MissionTrace, p: Vec3): void {
  const e = trace.pathExtremes;
  if (e.length === 0) {
    for (let i = 0; i < 6; i++) e.push({ ...p });
    return;
  }
  (["x", "y", "z"] as const).forEach((axis, i) => {
    if (p[axis] < e[2 * i][axis]) e[2 * i] = { ...p };
    if (p[axis] > e[2 * i + 1][axis]) e[2 * i + 1] = { ...p };
  });
}
