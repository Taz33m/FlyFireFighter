/**
 * Synthetic camera frames for controller tests. These are labelled test fixtures, not the twin's renderer
 * and not benchmark evidence.
 *
 * A small ray caster: textured planar surfaces in the world frame (metres, Z up), a pinhole camera that
 * uses the contract's optical convention (X right, Y down, Z along the lens axis) pitched like rgb-front,
 * deterministic multi-octave value-noise textures, brightness/contrast control and seeded Gaussian noise.
 * Texture octaves smaller than about two pixel footprints fade to their mean, as mipmapped rendering
 * would; unfiltered point sampling makes distant and grazing surfaces sparkle into meaningless flow.
 */
import type { Vec3 } from "../../contracts/frames.ts";
import { cross, vec3 } from "../../contracts/frames.ts";
import type { CameraFrame, CameraModel } from "./types.ts";
import { focalLengthPx } from "./types.ts";

export interface Surface {
  /** A point on the plane; texture coordinates are measured from it. */
  readonly origin: Vec3;
  /** Orthonormal in-plane axes; the plane normal is uAxis × vAxis. */
  readonly uAxis: Vec3;
  readonly vAxis: Vec3;
  /** Optional rectangle in (u, v) metres; unbounded when omitted. */
  readonly bounds?: { readonly uMin: number; readonly uMax: number; readonly vMin: number; readonly vMax: number };
  readonly seed: number;
  /** Largest texture feature size in metres (octaves at 1, 0.4 and 0.16 of it). */
  readonly textureScaleM: number;
}

export interface CameraPose {
  readonly position: Vec3;
  readonly yawRad: number;
}

export interface RenderOptions {
  readonly width: number;
  readonly height: number;
  readonly camera: CameraModel;
  /** Mean luminance and contrast gain: luminance = mean + gain × (texture − 0.5), clamped to [0, 1]. */
  readonly mean?: number;
  readonly gain?: number;
  /** Luminance where no surface is hit. */
  readonly background?: number;
  readonly noiseSigma?: number;
  readonly noiseSeed?: number;
}

export interface FrameMeta {
  readonly frameId: string;
  readonly captureTick: number;
  readonly calibrationId?: string;
}

export const SYNTHETIC_CALIBRATION = "synthetic-pinhole-v1";

export function plane(origin: Vec3, uAxis: Vec3, vAxis: Vec3, seed: number, textureScaleM = 0.3, bounds?: Surface["bounds"]): Surface {
  return { origin, uAxis, vAxis, seed, textureScaleM, bounds };
}

/** Seeded uniform generator in [0, 1) (mulberry32). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded standard normal generator (Box–Muller). */
export function gaussian(seed: number): () => number {
  const uniform = mulberry32(seed);
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed + 1, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

const OCTAVES: readonly { readonly amplitude: number; readonly scale: number; readonly seedOffset: number }[] = [
  { amplitude: 0.5, scale: 1, seedOffset: 0 },
  { amplitude: 0.3, scale: 0.4, seedOffset: 101 },
  { amplitude: 0.2, scale: 0.16, seedOffset: 202 },
];

/**
 * Texture value in [0, 1] at plane coordinates (u, v) metres. `footprintM` is the size of one pixel on the
 * surface; an octave fades to its mean between 4 and 2 footprints per feature (0 = unfiltered).
 */
export function texture(u: number, v: number, seed: number, scaleM: number, footprintM = 0): number {
  let value = 0;
  for (const octave of OCTAVES) {
    const size = octave.scale * scaleM;
    const keep = footprintM > 0 ? Math.min(1, Math.max(0, (size / footprintM - 2) / 2)) : 1;
    const noise = keep > 0 ? valueNoise(u / size, v / size, seed + octave.seedOffset) : 0.5;
    value += octave.amplitude * (0.5 + keep * (noise - 0.5));
  }
  return value;
}

interface PreparedSurface {
  readonly surface: Surface;
  readonly normal: Vec3;
  /** (origin − camera)·normal, and (camera − origin)·u / ·v. */
  readonly num: number;
  readonly pu: number;
  readonly pv: number;
}

function prepare(surface: Surface, eye: Vec3): PreparedSurface {
  const normal = cross(surface.uAxis, surface.vAxis);
  const ox = surface.origin.x - eye.x;
  const oy = surface.origin.y - eye.y;
  const oz = surface.origin.z - eye.z;
  return {
    surface,
    normal,
    num: ox * normal.x + oy * normal.y + oz * normal.z,
    pu: -(ox * surface.uAxis.x + oy * surface.uAxis.y + oz * surface.uAxis.z),
    pv: -(ox * surface.vAxis.x + oy * surface.vAxis.y + oz * surface.vAxis.z),
  };
}

/**
 * Nearest surface along world direction (dx, dy, dz); returns the texture value or NaN for no hit.
 * `pixelAngle` (radians per pixel) sets the texture filter footprint: distance × pixelAngle / cos(incidence).
 */
function trace(prepared: readonly PreparedSurface[], dx: number, dy: number, dz: number, pixelAngle: number): number {
  const d2 = dx * dx + dy * dy + dz * dz;
  let best = Infinity;
  let value = Number.NaN;
  for (const p of prepared) {
    const n = p.normal;
    const dn = dx * n.x + dy * n.y + dz * n.z;
    if (Math.abs(dn) < 1e-12) continue;
    const t = p.num / dn;
    if (!(t > 1e-6 && t < best)) continue;
    const s = p.surface;
    const u = p.pu + t * (dx * s.uAxis.x + dy * s.uAxis.y + dz * s.uAxis.z);
    const v = p.pv + t * (dx * s.vAxis.x + dy * s.vAxis.y + dz * s.vAxis.z);
    const b = s.bounds;
    if (b && (u < b.uMin || u > b.uMax || v < b.vMin || v > b.vMax)) continue;
    best = t;
    value = texture(u, v, s.seed, s.textureScaleM, (t * d2 * pixelAngle) / Math.abs(dn));
  }
  return value;
}

/** Render one luminance frame from `pose` (camera centre and body yaw; the camera pitch comes from the model). */
export function renderFrame(surfaces: readonly Surface[], pose: CameraPose, options: RenderOptions, meta: FrameMeta): CameraFrame {
  const { width, height, camera } = options;
  const mean = options.mean ?? 0.5;
  const gain = options.gain ?? 1.6;
  const background = options.background ?? mean;
  const sigma = options.noiseSigma ?? 0;
  const noise = sigma > 0 ? gaussian(options.noiseSeed ?? 1) : null;
  const f = focalLengthPx(camera, width);
  const cp = Math.cos(camera.pitchRad);
  const sp = Math.sin(camera.pitchRad);
  const cy = Math.cos(pose.yawRad);
  const sy = Math.sin(pose.yawRad);
  const prepared = surfaces.map(surface => prepare(surface, pose.position));
  const luminance = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    const y = (row + 0.5 - height / 2) / f;
    for (let col = 0; col < width; col++) {
      const x = (col + 0.5 - width / 2) / f;
      // Optical (x, y, 1) -> body (forward, left, up) for a camera pitched down by `pitch`, then -> world.
      const bx = cp - sp * y;
      const by = -x;
      const bz = -sp - cp * y;
      const tex = trace(prepared, cy * bx - sy * by, sy * bx + cy * by, bz, 1 / f);
      const value = Number.isNaN(tex) ? background : mean + gain * (tex - 0.5);
      const noisy = noise ? value + sigma * noise() : value;
      luminance[row * width + col] = Math.min(1, Math.max(0, noisy));
    }
  }
  return { frameId: meta.frameId, captureTick: meta.captureTick, width, height, luminance, calibrationId: meta.calibrationId ?? SYNTHETIC_CALIBRATION };
}

const X = vec3(1, 0, 0);
const Y = vec3(0, 1, 0);
const Z = vec3(0, 0, 1);
const NEG_X = vec3(-1, 0, 0);
const NEG_Y = vec3(0, -1, 0);

/** Wall facing −X at x = xM (an approaching aircraft heading +X sees it head-on). */
export function wallAtX(xM: number, seed: number, bounds?: Surface["bounds"]): Surface {
  return plane(vec3(xM, 0, 0), Y, Z, seed, 0.3, bounds);
}

/** Wall parallel to X at y = yM (left of an aircraft at y < yM heading +X). */
export function wallAtY(yM: number, seed: number, bounds?: Surface["bounds"]): Surface {
  return plane(vec3(0, yM, 0), yM > 0 ? X : NEG_X, Z, seed, 0.3, bounds);
}

export function floorAt(zM: number, seed: number): Surface {
  return plane(vec3(0, 0, zM), X, Y, seed, 0.3);
}

export function ceilingAt(zM: number, seed: number): Surface {
  return plane(vec3(0, 0, zM), X, NEG_Y, seed, 0.3);
}

/** Closed textured box room centred on the origin: walls at ±halfX, ±halfY, floor z = 0, ceiling z = heightM. */
export function boxRoom(halfX: number, halfY: number, heightM: number, seed: number): Surface[] {
  return [wallAtX(halfX, seed), plane(vec3(-halfX, 0, 0), NEG_Y, Z, seed + 1), wallAtY(halfY, seed + 2), wallAtY(-halfY, seed + 3), floorAt(0, seed + 4), ceilingAt(heightM, seed + 5)];
}
