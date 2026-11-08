/**
 * Coordinate frames. Units are metres and radians.
 *
 * - World: a local site frame, right-handed, Z up, metres. Authoritative for simulation, contracts and scene
 *   metadata. Its X/Y axes may be rotated from true east/north so walls align with axis-aligned colliders;
 *   each scene's metadata records that rotation and origin (troy-training: +X along Peoples Avenue at true
 *   bearing 101.10°). No indoor component uses true north or GPS.
 * - Body: X forward, Y left, Z up (FLU). Yaw is counter-clockwise about +Z, measured from world +X.
 * - Render (Three.js and glTF): Y up. world (x, y, z) -> render (x, z, -y).
 * - Camera optical (OpenCV convention): X right, Y down, Z forward along the lens axis.
 *
 * Convert only at boundaries (asset import, rendering, camera projection). Never mix frames inside a module.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Pose {
  readonly position: Vec3;
  readonly yawRad: number;
}

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const ZERO: Vec3 = Object.freeze(vec3(0, 0, 0));

export function add(a: Vec3, b: Vec3): Vec3 {
  return vec3(a.x + b.x, a.y + b.y, a.z + b.z);
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return vec3(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function scale(a: Vec3, k: number): Vec3 {
  return vec3(a.x * k, a.y * k, a.z * k);
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

export function norm(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  if (!(n > 0) || !Number.isFinite(n)) throw new RangeError("Cannot normalize a zero or non-finite vector");
  return scale(a, 1 / n);
}

export function isFiniteVec3(a: Vec3): boolean {
  return Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
}

/** Wrap an angle to (-π, π]. */
export function wrapAngle(rad: number): number {
  const twoPi = 2 * Math.PI;
  const wrapped = ((((rad + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

/** World-frame yaw that points from one position toward another (horizontal plane). */
export function yawBetween(from: Vec3, to: Vec3): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

export function rotateBodyToWorld(yawRad: number, v: Vec3): Vec3 {
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  return vec3(c * v.x - s * v.y, s * v.x + c * v.y, v.z);
}

export function rotateWorldToBody(yawRad: number, v: Vec3): Vec3 {
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  return vec3(c * v.x + s * v.y, -s * v.x + c * v.y, v.z);
}

export function bodyPointToWorld(pose: Pose, p: Vec3): Vec3 {
  return add(pose.position, rotateBodyToWorld(pose.yawRad, p));
}

export function worldPointToBody(pose: Pose, p: Vec3): Vec3 {
  return rotateWorldToBody(pose.yawRad, sub(p, pose.position));
}

/** World (Z up) to Three.js / glTF render coordinates (Y up). */
export function worldToRender(v: Vec3): Vec3 {
  return vec3(v.x, v.z, -v.y);
}

export function renderToWorld(v: Vec3): Vec3 {
  return vec3(v.x, -v.z, v.y);
}

/**
 * Body-frame vector to camera optical coordinates for a forward camera pitched down by `pitchRad`
 * (positive pitch looks below the horizon). The optical +Z axis is the lens axis.
 */
export function bodyToOptical(v: Vec3, pitchRad = 0): Vec3 {
  const c = Math.cos(pitchRad);
  const s = Math.sin(pitchRad);
  const forward = c * v.x - s * v.z;
  const up = s * v.x + c * v.z;
  return vec3(-v.y, -up, forward);
}

export function opticalToBody(v: Vec3, pitchRad = 0): Vec3 {
  const c = Math.cos(pitchRad);
  const s = Math.sin(pitchRad);
  const forward = v.z;
  const up = -v.y;
  return vec3(c * forward + s * up, -v.x, -s * forward + c * up);
}
