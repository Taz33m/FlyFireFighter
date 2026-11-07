/**
 * Occupant mobility and route policy (truth only; planners and the harness never read it).
 *
 * - shelter: a mobile occupant waits (idle, then crouching and coughing as smoke at head height rises) until
 *   guidance is perceivable — a fresh light cue whose origin is within LIGHT_PERCEPTION_RANGE_M with a clear,
 *   not too smoky line of sight to the head, or a recent spoken cue within AUDIO_PERCEPTION_RANGE_M — AND a
 *   passable route to a door-front exists (occupant-route.ts).
 * - follow / evacuate: walks the route at OCCUPANT_WALK_SPEED_MPS (slower under heavy smoke). While a light
 *   cue is perceivable ("follow") it walks toward the light's floor point when that point is in the same
 *   room, passable and ahead on the route; otherwise ("evacuate") toward the next node. A closed (not
 *   blocked) door on the route is opened once the occupant is within DOOR_REACH_M of its threshold: state
 *   "open", leaf collider removed, full clear area for ventilation, and an "occupant_activity" TruthEvent.
 *   It never steps into an active fire region and stops (back to shelter) whenever no passable route
 *   remains. Once started it keeps going without further cues while the route stays passable.
 * - outside: past the exit, walks straight to the assembly point (flat ground, no exterior obstacles).
 * - arrived: inside the assembly box; arrivalTick is set once.
 * - incapacitated: integrated smoke exposure reached INCAPACITATION_EXPOSURE (a crude toxicity proxy).
 * Immobile occupants never move on their own. Occupants do not collide with the aircraft.
 */
import type { Vec3 } from "../contracts/frames.ts";
import { add, distance, dot, horizontalDistance, scale, sub, vec3, ZERO } from "../contracts/frames.ts";
import { distanceToRegion, regionContains, representativePoint } from "../contracts/geometry.ts";
import { extinctionAt, opticalDepth } from "./fire.ts";
import { occupantHead } from "./occupant-body.ts";
import type { EvacuationRoute } from "./occupant-route.ts";
import { locateFeet, occupantBlockers, planEvacuationRoute, segmentPassable } from "./occupant-route.ts";
import { setDoorState } from "./openings.ts";
import { lineOfSight } from "./raycast.ts";
import { findOpening, openingThreshold } from "./scene.ts";
import type { OccupantActivity, OccupantAnimation, OccupantTruth, WorldState } from "./world-state.ts";
import { activeColliders } from "./world-state.ts";

export const OCCUPANT_WALK_SPEED_MPS = 1.0;
export const OCCUPANT_SMOKE_WALK_SPEED_MPS = 0.6;
export const LIGHT_PERCEPTION_RANGE_M = 6;
export const AUDIO_PERCEPTION_RANGE_M = 8;
/** A light cue counts while it was refreshed within this many ticks (guidance refreshes it every tick). */
export const LIGHT_CUE_MEMORY_TICKS = 25;
/** A spoken instruction is remembered for this many ticks. */
export const AUDIO_CUE_MEMORY_TICKS = 1000;
/** Light is not seen through more smoke than this optical depth (≈5 % transmission). */
export const LIGHT_MAX_OPTICAL_DEPTH = 3;
export const CROUCH_EXTINCTION_PER_M = 0.15;
export const COUGH_EXTINCTION_PER_M = 0.6;
/** Integrated head-height extinction, (1/m)·s, at which the occupant is incapacitated. Not a validated FED model. */
export const INCAPACITATION_EXPOSURE = 600;
/** An occupant opens a closed door on its route once its feet are this close (horizontally) to the threshold. */
export const DOOR_REACH_M = 0.6;
const REACHED_M = 0.05;
const LIGHT_AHEAD_MARGIN_M = 0.1;
const FIRE_CONTACT_M = 0.05;
const BODY_CHECK_HEIGHTS_M = [0.1, 1.0];

export function stepOccupants(world: WorldState, dtS: number): void {
  for (const occupant of world.occupants) stepOccupant(world, occupant, dtS);
}

function stepOccupant(world: WorldState, o: OccupantTruth, dtS: number): void {
  if (o.activity === "arrived" || o.activity === "incapacitated") return hold(o, o.activity === "arrived" ? "idle" : "crouch");
  const smoke = extinctionAt(world, occupantHead(o));
  o.smokeExposure += smoke * dtS;
  if (o.smokeExposure >= INCAPACITATION_EXPOSURE) {
    setActivity(world, o, "incapacitated");
    return hold(o, "crouch");
  }
  if (o.mobility === "immobile") return hold(o, shelterAnimation(smoke));
  if (o.activity === "outside" || locateFeet(world.scene, o.position).kind === "exterior") return walkOutside(world, o, dtS);
  const cue = perceivedCue(world, o);
  if (o.activity === "shelter" && cue === null) return hold(o, shelterAnimation(smoke));
  const route = planEvacuationRoute(world, o.position);
  if (!route) {
    setActivity(world, o, "shelter");
    return hold(o, shelterAnimation(smoke));
  }
  setActivity(world, o, cue === "light" ? "follow" : "evacuate");
  walkRoute(world, o, route, cue === "light", smoke, dtS);
}

function hold(o: OccupantTruth, animation: OccupantAnimation): void {
  o.velocity = ZERO;
  o.animation = animation;
}

function shelterAnimation(smoke: number): OccupantAnimation {
  if (smoke >= COUGH_EXTINCTION_PER_M) return "cough";
  return smoke >= CROUCH_EXTINCTION_PER_M ? "crouch" : "idle";
}

function setActivity(world: WorldState, o: OccupantTruth, next: OccupantActivity): void {
  if (o.activity === next) return;
  world.truthEvents.push({ tick: world.tick, kind: "occupant_activity", detail: `Occupant ${o.key}: ${o.activity} → ${next}.`, data: { occupantKey: o.key, from: o.activity, to: next } });
  o.activity = next;
}

function lightPerceivable(world: WorldState, head: Vec3): boolean {
  const light = world.cues.light;
  if (!light || world.tick - light.tick > LIGHT_CUE_MEMORY_TICKS || distance(light.origin, head) > LIGHT_PERCEPTION_RANGE_M) return false;
  return lineOfSight(activeColliders(world), light.origin, head) && opticalDepth(world, light.origin, head) <= LIGHT_MAX_OPTICAL_DEPTH;
}

function audioPerceivable(world: WorldState, head: Vec3): boolean {
  const audio = world.cues.audio;
  return audio !== null && world.tick - audio.tick <= AUDIO_CUE_MEMORY_TICKS && distance(audio.origin, head) <= AUDIO_PERCEPTION_RANGE_M;
}

export function perceivedCue(world: WorldState, o: OccupantTruth): "light" | "audio" | null {
  const head = occupantHead(o);
  if (lightPerceivable(world, head)) return "light";
  return audioPerceivable(world, head) ? "audio" : null;
}

/** True when p lies on the open segment a→b (within REACHED_M), i.e. a is already behind it. */
function pastStart(p: Vec3, a: Vec3, b: Vec3): boolean {
  const ab = sub(b, a);
  const lengthSquared = dot(ab, ab);
  if (lengthSquared < 1e-12) return false;
  const t = dot(sub(p, a), ab) / lengthSquared;
  return t > 0 && t < 1 && distance(p, add(a, scale(ab, t))) <= REACHED_M;
}

/** First waypoint not yet reached or passed (e.g. a stair top once the occupant is on the stair below it). */
function nextWaypointIndex(p: Vec3, waypoints: readonly Vec3[]): number {
  const last = waypoints.length - 1;
  let index = 0;
  while (index < last && (distance(p, waypoints[index]) <= REACHED_M || pastStart(p, waypoints[index], waypoints[index + 1]))) index += 1;
  return index;
}

/** Opens every closed door on the route whose threshold is within reach; blocked doors never appear on a route. */
function openDoorsWithinReach(world: WorldState, o: OccupantTruth, route: EvacuationRoute): void {
  for (const openingId of route.crossings) {
    const opening = openingId === null ? null : findOpening(world.scene, openingId);
    if (!opening || opening.kind !== "door" || world.openings.find(t => t.id === opening.id)?.state !== "closed") continue;
    const threshold = openingThreshold(opening);
    if (horizontalDistance(o.position, threshold) > DOOR_REACH_M || Math.abs(o.position.z - threshold.z) > 1) continue;
    setDoorState(world, opening.id, "open");
    world.truthEvents.push({ tick: world.tick, kind: "occupant_activity", detail: `Occupant ${o.key} opened ${opening.id}.`, data: { occupantKey: o.key, action: "opened_door", openingId: opening.id } });
  }
}

function walkRoute(world: WorldState, o: OccupantTruth, route: EvacuationRoute, followLight: boolean, smoke: number, dtS: number): void {
  openDoorsWithinReach(world, o, route);
  const last = route.waypoints.length - 1;
  const index = nextWaypointIndex(o.position, route.waypoints);
  const next = route.waypoints[index];
  const target = (followLight ? lightFloorTarget(world, o, next) : null) ?? next;
  const speed = smoke >= COUGH_EXTINCTION_PER_M ? OCCUPANT_SMOKE_WALK_SPEED_MPS : OCCUPANT_WALK_SPEED_MPS;
  stepToward(world, o, target, speed, dtS, followLight ? "follow" : "walk");
  if (index === last && distance(o.position, next) <= REACHED_M) setActivity(world, o, "outside");
}

/** The light's floor point when it is in the occupant's room, passable and ahead of the occupant on the route. */
function lightFloorTarget(world: WorldState, o: OccupantTruth, next: Vec3): Vec3 | null {
  const light = world.cues.light;
  const here = locateFeet(world.scene, o.position);
  if (!light || here.kind !== "room") return null;
  const spot = vec3(light.target.x, light.target.y, o.position.z);
  const there = locateFeet(world.scene, spot);
  if (there.kind !== "room" || there.roomId !== here.roomId) return null;
  if (distance(o.position, spot) <= REACHED_M || distance(spot, next) >= distance(o.position, next) - LIGHT_AHEAD_MARGIN_M) return null;
  const blockers = occupantBlockers(world);
  return segmentPassable(world, blockers, o.position, spot) && segmentPassable(world, blockers, spot, next) ? spot : null;
}

function touchesFire(world: WorldState, feet: Vec3): boolean {
  return world.fires.some(fire => !fire.extinguished && BODY_CHECK_HEIGHTS_M.some(h => distanceToRegion(fire.region, vec3(feet.x, feet.y, feet.z + h)) <= FIRE_CONTACT_M));
}

function stepToward(world: WorldState, o: OccupantTruth, target: Vec3, speedMps: number, dtS: number, animation: OccupantAnimation): void {
  const remaining = distance(o.position, target);
  const step = Math.min(speedMps * dtS, remaining);
  o.animation = animation;
  if (!(step > 0)) {
    o.velocity = ZERO;
    return;
  }
  const direction = scale(sub(target, o.position), 1 / remaining);
  const next = add(o.position, scale(direction, step));
  if (touchesFire(world, next)) {
    o.velocity = ZERO;
    return;
  }
  o.velocity = scale(direction, step / dtS);
  o.position = next;
  if (Math.hypot(direction.x, direction.y) > 1e-9) o.yawRad = Math.atan2(direction.y, direction.x);
}

function walkOutside(world: WorldState, o: OccupantTruth, dtS: number): void {
  setActivity(world, o, "outside");
  const assembly = world.scene.assemblyPoint;
  if (!arrive(world, o)) {
    const center = representativePoint(assembly);
    stepToward(world, o, vec3(center.x, center.y, o.position.z), OCCUPANT_WALK_SPEED_MPS, dtS, "walk");
    arrive(world, o);
  }
}

/** Marks arrival once the feet are inside the assembly box. */
function arrive(world: WorldState, o: OccupantTruth): boolean {
  if (!regionContains(world.scene.assemblyPoint, vec3(o.position.x, o.position.y, o.position.z + 0.05))) return false;
  o.arrivalTick = world.tick;
  setActivity(world, o, "arrived");
  world.truthEvents.push({ tick: world.tick, kind: "occupant_arrived", detail: `Occupant ${o.key} reached the assembly point.`, data: { occupantKey: o.key, position: { ...o.position } } });
  hold(o, "idle");
  return true;
}
