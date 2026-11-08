/**
 * Ray and segment queries against axis-aligned collider boxes (slab method). Shared by sensors,
 * occupant line of sight and coverage footprints.
 */
import type { Vec3 } from "../contracts/frames.ts";
import type { RuntimeCollider } from "./world-state.ts";

export interface RayHit {
  readonly distanceM: number;
  readonly colliderId: string;
  readonly kind: RuntimeCollider["kind"];
}

/** Entry distance of a ray into a box, or null. A ray starting inside the box hits at 0. */
export function rayBoxDistance(origin: Vec3, direction: Vec3, min: Vec3, max: Vec3, maxDistanceM: number): number | null {
  let near = 0;
  let far = maxDistanceM;
  const axes: ["x", "y", "z"] = ["x", "y", "z"];
  for (const axis of axes) {
    const o = origin[axis];
    const d = direction[axis];
    if (Math.abs(d) < 1e-12) {
      if (o < min[axis] || o > max[axis]) return null;
      continue;
    }
    let t1 = (min[axis] - o) / d;
    let t2 = (max[axis] - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    near = Math.max(near, t1);
    far = Math.min(far, t2);
    if (near > far) return null;
  }
  return near;
}

/** Nearest hit along a unit-direction ray among the given colliders, within maxDistanceM. */
export function raycast(colliders: readonly RuntimeCollider[], origin: Vec3, direction: Vec3, maxDistanceM: number, ignore?: (collider: RuntimeCollider) => boolean): RayHit | null {
  let best: RayHit | null = null;
  for (const collider of colliders) {
    if (ignore?.(collider)) continue;
    const t = rayBoxDistance(origin, direction, collider.min, collider.max, best?.distanceM ?? maxDistanceM);
    if (t !== null && (best === null || t < best.distanceM)) best = { distanceM: t, colliderId: collider.id, kind: collider.kind };
  }
  return best;
}

/** True when nothing blocks the open segment between a and b. */
export function lineOfSight(colliders: readonly RuntimeCollider[], a: Vec3, b: Vec3, ignore?: (collider: RuntimeCollider) => boolean): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-9) return true;
  const direction = { x: dx / length, y: dy / length, z: dz / length };
  const hit = raycast(colliders, a, direction, length - 1e-6, ignore);
  return hit === null;
}
