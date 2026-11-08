/**
 * Small ray/region geometry helpers shared by the fire model (water spray, flame chords) and the sensor
 * models (beam sub-rays). Exact for spheres and boxes; other region kinds are sampled along the ray.
 */
import type { Vec3 } from "../../contracts/frames.ts";
import { cross, normalize, vec3 } from "../../contracts/frames.ts";
import type { Region } from "../../contracts/geometry.ts";
import { regionContains } from "../../contracts/geometry.ts";

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const SAMPLE_STEP_M = 0.05;

/** Two unit vectors perpendicular to the unit axis w and to each other. */
export function perpendicularBasis(w: Vec3): readonly [Vec3, Vec3] {
  const helper = Math.abs(w.z) < 0.9 ? vec3(0, 0, 1) : vec3(1, 0, 0);
  const u = normalize(cross(w, helper));
  return [u, cross(w, u)];
}

/**
 * Deterministic directions spread uniformly in solid angle within a cone (golden-angle spiral over the
 * spherical cap). Used where a beam or jet is represented by a fixed bundle of rays.
 */
export function coneDirections(axis: Vec3, halfAngleRad: number, count: number): Vec3[] {
  const w = normalize(axis);
  const [u, v] = perpendicularBasis(w);
  const cosMax = Math.cos(halfAngleRad);
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const c = 1 - ((i + 0.5) / count) * (1 - cosMax);
    const s = Math.sqrt(Math.max(0, 1 - c * c));
    const cu = Math.cos(i * GOLDEN_ANGLE) * s;
    const sv = Math.sin(i * GOLDEN_ANGLE) * s;
    out.push(vec3(w.x * c + u.x * cu + v.x * sv, w.y * c + u.y * cu + v.y * sv, w.z * c + u.z * cu + v.z * sv));
  }
  return out;
}

/** [entry, exit] distances of a unit-direction ray inside the region, clipped to [0, maxDistanceM], or null. */
export function rayChord(region: Region, origin: Vec3, dir: Vec3, maxDistanceM: number): readonly [number, number] | null {
  if (region.kind === "sphere") return sphereChord(region.center, region.radiusM, origin, dir, maxDistanceM);
  if (region.kind === "box") return boxChord(region.min, region.max, origin, dir, maxDistanceM);
  return sampledChord(region, origin, dir, maxDistanceM);
}

/** Distance along a unit ray to where it first enters the region (0 when it starts inside), or null. */
export function rayRegionEntry(region: Region, origin: Vec3, dir: Vec3, maxDistanceM: number): number | null {
  const chord = rayChord(region, origin, dir, maxDistanceM);
  return chord === null ? null : chord[0];
}

/** Length of the segment a→b that lies inside the region. */
export function segmentChordLength(region: Region, a: Vec3, b: Vec3): number {
  const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  if (length < 1e-9) return 0;
  const dir = vec3((b.x - a.x) / length, (b.y - a.y) / length, (b.z - a.z) / length);
  const chord = rayChord(region, a, dir, length);
  return chord === null ? 0 : Math.max(0, chord[1] - chord[0]);
}

function sphereChord(center: Vec3, radiusM: number, o: Vec3, d: Vec3, maxD: number): readonly [number, number] | null {
  const ox = o.x - center.x;
  const oy = o.y - center.y;
  const oz = o.z - center.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - radiusM * radiusM;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const t0 = Math.max(0, -b - root);
  const t1 = Math.min(maxD, -b + root);
  return t0 <= t1 ? [t0, t1] : null;
}

function boxChord(min: Vec3, max: Vec3, o: Vec3, d: Vec3, maxD: number): readonly [number, number] | null {
  let near = 0;
  let far = maxD;
  const axes: readonly (readonly [number, number, number, number])[] = [
    [o.x, d.x, min.x, max.x],
    [o.y, d.y, min.y, max.y],
    [o.z, d.z, min.z, max.z],
  ];
  for (const [origin, direction, lo, hi] of axes) {
    if (Math.abs(direction) < 1e-12) {
      if (origin < lo || origin > hi) return null;
      continue;
    }
    const ta = (lo - origin) / direction;
    const tb = (hi - origin) / direction;
    near = Math.max(near, Math.min(ta, tb));
    far = Math.min(far, Math.max(ta, tb));
    if (near > far) return null;
  }
  return [near, far];
}

function sampledChord(region: Region, o: Vec3, d: Vec3, maxD: number): readonly [number, number] | null {
  let entry: number | null = null;
  let exit = 0;
  for (let s = 0; s <= maxD + 1e-9; s += SAMPLE_STEP_M) {
    const inside = regionContains(region, vec3(o.x + d.x * s, o.y + d.y * s, o.z + d.z * s));
    if (inside && entry === null) entry = s;
    if (inside) exit = s;
    else if (entry !== null) break;
  }
  return entry === null ? null : [entry, Math.min(maxD, exit)];
}
