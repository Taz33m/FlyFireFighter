/**
 * Swept collision of the aircraft against the active collider boxes.
 *
 * The aircraft is a sphere of radius spanM/2 about its body origin. Each step is split into sub-steps no
 * longer than a quarter radius, so the centre cannot cross a box (thickness + 2r ≥ 2r) between checks at
 * any speed: there is no tunnelling through thin glass or door leaves. On contact while moving into a box,
 * the aircraft stays at its last free position, the velocity component into the box is removed (it may
 * slide along the surface) and a "collision" TruthEvent is recorded. Contacts within
 * COLLISION_DEBOUNCE_TICKS of the previous contact extend that collision instead of counting a new one.
 * A slow, level descent onto the upward-facing top face of any box is a touchdown, not a collision. Support
 * is decided by contact geometry, not by collider kind: the top of a mass or ceiling box that forms a flat roof
 * supports the aircraft just as a floor does, while striking the side or underside of any box (a wall face, a
 * ceiling from below) is always a collision.
 */
import type { Vec3 } from "../contracts/frames.ts";
import { add, dot, norm, scale, sub, vec3 } from "../contracts/frames.ts";
import type { RuntimeCollider, WorldState } from "./world-state.ts";
import { activeColliders } from "./world-state.ts";

export const COLLISION_DEBOUNCE_TICKS = 50;
/** Largest approach and horizontal speed of a touchdown onto a support surface, m/s. */
export const TOUCHDOWN_MAX_SPEED_MPS = 0.6;
/** A touched-down aircraft is within this distance of its support and nearly still. */
const REST_GAP_M = 0.03;
const REST_SPEED_MPS = 0.05;
/** A contact normal at least this upward means the aircraft is over the box's top face (or its rim). */
const TOP_FACE_NORMAL_Z = 0.7;

export function droneRadiusM(world: WorldState): number {
  return world.profile.spanM / 2;
}

interface BoxProximity {
  readonly distanceM: number;
  /** Unit vector from the box toward the point (the outward face normal when the point is inside). */
  readonly normal: Vec3;
}

/** Distance from p to the box and the outward direction. */
export function boxProximity(min: Vec3, max: Vec3, p: Vec3): BoxProximity {
  const q = vec3(Math.max(min.x, Math.min(max.x, p.x)), Math.max(min.y, Math.min(max.y, p.y)), Math.max(min.z, Math.min(max.z, p.z)));
  const d = sub(p, q);
  const distanceM = norm(d);
  if (distanceM > 1e-9) return { distanceM, normal: scale(d, 1 / distanceM) };
  // Inside: push out through the nearest face.
  const faces: [number, Vec3][] = [
    [p.x - min.x, vec3(-1, 0, 0)], [max.x - p.x, vec3(1, 0, 0)],
    [p.y - min.y, vec3(0, -1, 0)], [max.y - p.y, vec3(0, 1, 0)],
    [p.z - min.z, vec3(0, 0, -1)], [max.z - p.z, vec3(0, 0, 1)],
  ];
  faces.sort((a, b) => a[0] - b[0]);
  return { distanceM: 0, normal: faces[0][1] };
}

interface Contact {
  readonly collider: RuntimeCollider;
  readonly normal: Vec3;
}

/** The first collider the sphere at `p` penetrates while moving along `v` into it, or null. */
function contactAt(colliders: readonly RuntimeCollider[], p: Vec3, radiusM: number, v: Vec3): Contact | null {
  for (const collider of colliders) {
    const { min, max } = collider;
    if (p.x < min.x - radiusM || p.x > max.x + radiusM || p.y < min.y - radiusM || p.y > max.y + radiusM || p.z < min.z - radiusM || p.z > max.z + radiusM) continue;
    const proximity = boxProximity(min, max, p);
    if (proximity.distanceM < radiusM - 1e-9 && dot(v, proximity.normal) < 0) return { collider, normal: proximity.normal };
  }
  return null;
}

function isTouchdown(contact: Contact, v: Vec3): boolean {
  return contact.normal.z > TOP_FACE_NORMAL_Z
    && -dot(v, contact.normal) <= TOUCHDOWN_MAX_SPEED_MPS
    && Math.hypot(v.x, v.y) <= TOUCHDOWN_MAX_SPEED_MPS;
}

function recordCollision(world: WorldState, contact: Contact, speedMps: number): void {
  const drone = world.drone;
  const previous = drone.lastCollisionTick;
  drone.lastCollisionTick = world.tick;
  if (previous !== null && world.tick - previous <= COLLISION_DEBOUNCE_TICKS) return;
  drone.collisions += 1;
  const { collider } = contact;
  world.truthEvents.push({
    tick: world.tick,
    kind: "collision",
    detail: `Aircraft struck ${collider.kind} "${collider.id}" at ${speedMps.toFixed(2)} m/s.`,
    data: { colliderId: collider.id, colliderKind: collider.kind, speedMps, position: { ...drone.position } },
  });
}

/** Integrates the aircraft position over dtS with swept contact against the active colliders. */
export function moveDrone(world: WorldState, dtS: number): void {
  const drone = world.drone;
  const radiusM = droneRadiusM(world);
  const colliders = activeColliders(world);
  const travel = norm(drone.velocity) * dtS;
  const steps = Math.max(1, Math.ceil(travel / (radiusM / 4)));
  const subDt = dtS / steps;
  let position = drone.position;
  let velocity = drone.velocity;
  for (let i = 0; i < steps; i++) {
    const next = add(position, scale(velocity, subDt));
    const contact = contactAt(colliders, next, radiusM, velocity);
    if (!contact) {
      position = next;
      continue;
    }
    const approach = -dot(velocity, contact.normal);
    if (!isTouchdown(contact, velocity)) recordCollision(world, contact, approach);
    velocity = add(velocity, scale(contact.normal, approach));
  }
  drone.position = position;
  drone.velocity = velocity;
}

/** True when the aircraft rests on a box's top face: nearly still and within a few centimetres above it. */
export function isTouchedDown(world: WorldState): boolean {
  const drone = world.drone;
  if (norm(drone.velocity) > REST_SPEED_MPS) return false;
  const radiusM = droneRadiusM(world);
  return activeColliders(world).some(collider => {
    const proximity = boxProximity(collider.min, collider.max, drone.position);
    return proximity.distanceM <= radiusM + REST_GAP_M && proximity.normal.z > TOP_FACE_NORMAL_Z;
  });
}
