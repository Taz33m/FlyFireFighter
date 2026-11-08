/**
 * Allocation-free ray tracing for sensor hot loops. Each capture first selects the active colliders within
 * reach of the sensor (a simple broadphase) and flattens their boxes; every ray then runs the same slab test
 * as raycast.ts (entry distance, 0 when starting inside, nearest wins, ties keep the first collider).
 */
import type { Vec3 } from "../../contracts/frames.ts";
import type { RuntimeCollider, WorldState } from "../world-state.ts";

export interface TraceSet {
  readonly colliders: readonly RuntimeCollider[];
  /** minX, minY, minZ, maxX, maxY, maxZ per collider. */
  readonly bounds: Float64Array;
  /** Distance of the most recent traceNearest hit (Infinity after a miss); scratch output, not state. */
  distance: number;
}

/** Active colliders whose boxes come within reachM of the origin. */
export function traceSet(world: WorldState, origin: Vec3, reachM: number): TraceSet {
  const selected: RuntimeCollider[] = [];
  for (const collider of world.scene.colliders) {
    if (world.activeColliderIds.has(collider.id) && boxDistance(collider, origin) <= reachM) selected.push(collider);
  }
  const bounds = new Float64Array(selected.length * 6);
  selected.forEach((c, i) => bounds.set([c.min.x, c.min.y, c.min.z, c.max.x, c.max.y, c.max.z], i * 6));
  return { colliders: selected, bounds, distance: Infinity };
}

/** Index of the nearest collider hit by the unit ray within maxDistanceM, or -1; the distance goes to set.distance. */
export function traceNearest(set: TraceSet, o: Vec3, d: Vec3, maxDistanceM: number, skip?: (collider: RuntimeCollider) => boolean): number {
  let best = -1;
  let bestDistance = maxDistanceM;
  for (let i = 0; i < set.colliders.length; i++) {
    if (skip !== undefined && skip(set.colliders[i])) continue;
    const t = slab(set.bounds, i * 6, o, d, bestDistance);
    if (t >= 0 && (best < 0 || t < bestDistance)) {
      best = i;
      bestDistance = t;
    }
  }
  set.distance = best < 0 ? Infinity : bestDistance;
  return best;
}

/**
 * traceNearest over a subset of the set (indices[0..count), ascending, e.g. the colliders a frustum test kept):
 * the same result as traceNearest whenever the subset holds every collider the ray could hit.
 */
export function traceNearestIn(set: TraceSet, indices: Int32Array, count: number, o: Vec3, d: Vec3, maxDistanceM: number): number {
  let best = -1;
  let bestDistance = maxDistanceM;
  for (let n = 0; n < count; n++) {
    const i = indices[n];
    const t = slab(set.bounds, i * 6, o, d, bestDistance);
    if (t >= 0 && (best < 0 || t < bestDistance)) {
      best = i;
      bestDistance = t;
    }
  }
  set.distance = best < 0 ? Infinity : bestDistance;
  return best;
}

/**
 * True when the ray entered the box through its top face (an upward-facing surface: a floor, the ground, a
 * roof or a table top). Entry exactly on an edge or from inside the box counts as not upward.
 */
export function entersTopFace(set: TraceSet, index: number, o: Vec3, d: Vec3): boolean {
  if (!(d.z < 0)) return false;
  const b = set.bounds;
  const k = index * 6;
  const tz = (b[k + 5] - o.z) / d.z;
  if (!(tz > 0)) return false;
  const entry = (lo: number, hi: number, origin: number, dir: number) => (Math.abs(dir) < 1e-12 ? -Infinity : ((dir > 0 ? lo : hi) - origin) / dir);
  const margin = 1e-9 * (1 + tz);
  return tz > entry(b[k], b[k + 3], o.x, d.x) + margin && tz > entry(b[k + 1], b[k + 4], o.y, d.y) + margin;
}

/** True when nothing in the set blocks the open segment a→b. */
export function traceClear(set: TraceSet, a: Vec3, b: Vec3, skip?: (collider: RuntimeCollider) => boolean): boolean {
  const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  if (length < 1e-9) return true;
  const d = { x: (b.x - a.x) / length, y: (b.y - a.y) / length, z: (b.z - a.z) / length };
  return traceNearest(set, a, d, length - 1e-6, skip) < 0;
}

/** |cos| of the angle between the ray and the normal of the box face it hit at distance t. */
export function hitIncidenceCos(set: TraceSet, index: number, o: Vec3, d: Vec3, t: number): number {
  const b = set.bounds;
  const k = index * 6;
  const ex = Math.min(Math.abs(o.x + d.x * t - b[k]), Math.abs(o.x + d.x * t - b[k + 3]));
  const ey = Math.min(Math.abs(o.y + d.y * t - b[k + 1]), Math.abs(o.y + d.y * t - b[k + 4]));
  const ez = Math.min(Math.abs(o.z + d.z * t - b[k + 2]), Math.abs(o.z + d.z * t - b[k + 5]));
  // On an edge or corner several faces are equally near: use the one facing the ray best.
  const m = Math.min(ex, ey, ez) + 1e-9;
  return Math.max(ex <= m ? Math.abs(d.x) : 0, ey <= m ? Math.abs(d.y) : 0, ez <= m ? Math.abs(d.z) : 0);
}

/**
 * Smallest extent of the box across the ray: each axis extent divided by √(1 − d_axis²), so an extent along
 * the ray does not count. A glass pane seen edge-on or a table leg is thin; a pane seen face-on is not.
 */
export function crossSectionM(collider: RuntimeCollider, d: Vec3): number {
  const across = (extent: number, component: number) => extent / Math.max(1e-3, Math.sqrt(Math.max(0, 1 - component * component)));
  return Math.min(across(collider.max.x - collider.min.x, d.x), across(collider.max.y - collider.min.y, d.y), across(collider.max.z - collider.min.z, d.z));
}

const span = new Float64Array(2);

function clipAxis(o: number, d: number, lo: number, hi: number): boolean {
  if (Math.abs(d) < 1e-12) return o >= lo && o <= hi;
  const ta = (lo - o) / d;
  const tb = (hi - o) / d;
  const t1 = ta < tb ? ta : tb;
  const t2 = ta < tb ? tb : ta;
  if (t1 > span[0]) span[0] = t1;
  if (t2 < span[1]) span[1] = t2;
  return span[0] <= span[1];
}

function slab(b: Float64Array, k: number, o: Vec3, d: Vec3, maxDistanceM: number): number {
  span[0] = 0;
  span[1] = maxDistanceM;
  if (!clipAxis(o.x, d.x, b[k], b[k + 3])) return -1;
  if (!clipAxis(o.y, d.y, b[k + 1], b[k + 4])) return -1;
  if (!clipAxis(o.z, d.z, b[k + 2], b[k + 5])) return -1;
  return span[0];
}

function boxDistance(collider: RuntimeCollider, p: Vec3): number {
  const dx = Math.max(collider.min.x - p.x, 0, p.x - collider.max.x);
  const dy = Math.max(collider.min.y - p.y, 0, p.y - collider.max.y);
  const dz = Math.max(collider.min.z - p.z, 0, p.z - collider.max.z);
  return Math.hypot(dx, dy, dz);
}
