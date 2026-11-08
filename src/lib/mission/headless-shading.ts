/**
 * Shading model of the headless collider renderer v1 (see headless-camera.ts).
 *
 * Deterministic and allocation-free per pixel: a per-kind albedo, two octaves of value noise on world
 * coordinates of the hit face (optical flow and FlyVis need texture; a flat box gives them nothing), one
 * fixed directional light plus ambient, a sky gradient for rays that hit nothing, and an emissive flame
 * ellipsoid per active fire. Values are linear-light luminance before exposure and gamma. These are
 * presentation constants of a simplified renderer, not measured material data.
 */
import type { ColliderKind } from "../contracts/scene.ts";

/** Renderer-internal kinds: scene collider kinds plus an occupant body proxy. */
export type ShadedKind = ColliderKind | "person";

export const SHADED_KINDS: readonly ShadedKind[] = ["ground", "wall", "floor", "ceiling", "roof", "stair", "furniture", "glass", "door", "tree", "street_furniture", "person"];

/** Linear albedo per kind (index = SHADED_KINDS order). Intact glass renders as a dark pane (no transparency in v1). */
const ALBEDO: Readonly<Record<ShadedKind, number>> = {
  ground: 0.32, wall: 0.62, floor: 0.42, ceiling: 0.72, roof: 0.28, stair: 0.5, furniture: 0.36, glass: 0.15, door: 0.46, tree: 0.3, street_furniture: 0.3, person: 0.52,
};

export const ALBEDO_BY_CODE: Float64Array = Float64Array.from(SHADED_KINDS.map(kind => ALBEDO[kind]));

export const KIND_CODE: ReadonlyMap<ShadedKind, number> = new Map(SHADED_KINDS.map((kind, index) => [kind, index]));

/** Fixed light: a high sun from the south-east of the site frame, plus ambient. */
export const LIGHT = Object.freeze({ x: 0.36, y: -0.28, z: 0.89, ambient: 0.38, diffuse: 0.62 });

/**
 * Texture: zero-mean value-noise octaves (cycles per metre and amplitude) on the hit face's two in-plane
 * axes, around a mean multiplier. Each octave fades out as its period approaches the pixel footprint
 * (full at ≥ 4 px per period, gone at ≤ 2 px), like mip-mapping: near surfaces get fine grain, distant
 * ones only what the camera can resolve, so distant texture never aliases into flicker. Smooth value noise
 * alone has weak gradients at the scales a 4×-downsampled flow grid resolves (real ground, walls and foliage
 * have edges: paving joints, grass patches, stains), so one coarse layer of hard-edged patches (the sign of
 * a noise field, with its edge ramp widened to 1.5 pixel footprints so it stays anti-aliased) adds them.
 */
export const TEXTURE = Object.freeze({
  mean: 0.85,
  min: 0.08,
  octaves: [[0.2, 0.3], [0.6, 0.28], [1.8, 0.2], [5.4, 0.17], [16.2, 0.14], [48.6, 0.11]] as readonly (readonly [number, number])[],
  /** Hard-edged patch layer: cycles per metre and amplitude. */
  patches: [0.45, 0.16] as readonly [number, number],
});

export const SKY = Object.freeze({ horizon: 0.58, zenith: 0.9, belowHorizon: 0.3 });

/** Linear luminance a fully attenuating smoke layer converges to (light grey; dimmer than sky). */
export const SMOKE_LUMINANCE = 0.42;

/** Luminance of a missed ray from its world-frame elevation component dz. */
export function skyLuminance(dz: number): number {
  return dz >= 0 ? SKY.horizon + (SKY.zenith - SKY.horizon) * dz : SKY.belowHorizon;
}

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Lattice values come from one precomputed 256 × 256 table of hashed values; each seed reads it at its own
 * offset. The noise therefore repeats every 256 lattice cells (≥ 5 m for the finest octave), which no frame
 * can resolve, and costs four table reads instead of four hashes per octave.
 */
const LATTICE_BITS = 8;
const LATTICE_MASK = (1 << LATTICE_BITS) - 1;
const LATTICE: Float64Array = (() => {
  const table = new Float64Array(1 << (2 * LATTICE_BITS));
  for (let j = 0; j <= LATTICE_MASK; j++) for (let i = 0; i <= LATTICE_MASK; i++) table[(j << LATTICE_BITS) | i] = hash2(i, j, 0x5eed);
  return table;
})();

function lattice(ix: number, iy: number): number {
  return LATTICE[((iy & LATTICE_MASK) << LATTICE_BITS) | (ix & LATTICE_MASK)];
}

/** Smoothly interpolated lattice noise in [0, 1). */
export function valueNoise(u: number, v: number, seed: number): number {
  const fu = Math.floor(u);
  const fv = Math.floor(v);
  const tu = u - fu;
  const tv = v - fv;
  const su = tu * tu * (3 - 2 * tu);
  const sv = tv * tv * (3 - 2 * tv);
  const ix = fu + Math.imul(seed, 0x2f);
  const iy = fv + Math.imul(seed, 0x61);
  const a = lattice(ix, iy);
  const b = lattice(ix + 1, iy);
  const c = lattice(ix, iy + 1);
  const d = lattice(ix + 1, iy + 1);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

/**
 * Texture multiplier for in-plane face coordinates (u, v) in metres, band-limited to a pixel footprint of
 * `footprintM` metres: the mean multiplier plus every octave whose period spans enough pixels.
 */
export function surfaceTexture(u: number, v: number, seed: number, footprintM: number): number {
  let value = TEXTURE.mean;
  for (let i = 0; i < TEXTURE.octaves.length; i++) {
    const [frequency, amplitude] = TEXTURE.octaves[i];
    const pixelsPerPeriod = 1 / (frequency * Math.max(footprintM, 1e-6));
    const weight = pixelsPerPeriod >= 4 ? 1 : pixelsPerPeriod <= 2 ? 0 : (pixelsPerPeriod - 2) / 2;
    if (weight === 0) break;
    value += weight * amplitude * 2 * (valueNoise(u * frequency, v * frequency, seed + i * 7919) - 0.5);
  }
  const [pf, pa] = TEXTURE.patches;
  const patchPx = 1 / (pf * Math.max(footprintM, 1e-6));
  if (patchPx > 2) {
    // The noise changes by about 2·pf per metre near its midpoint: a ramp of 1.5 footprints in noise units.
    const ramp = Math.max(1e-6, 3 * pf * footprintM);
    const step = (valueNoise(u * pf, v * pf, seed + 104729) - 0.5) / ramp;
    value += Math.min(1, (patchPx - 2) / 2) * pa * (step > 1 ? 1 : step < -1 ? -1 : step);
  }
  return value > TEXTURE.min ? value : TEXTURE.min;
}

/**
 * Lambert shading of a box face hit. axis is the face normal's axis (0 x, 1 y, 2 z) and sign its direction;
 * (px, py, pz) the hit point. Each kind and axis gets its own texture seed so adjacent faces differ.
 */
export function shadeHit(kindCode: number, axis: number, sign: number, px: number, py: number, pz: number, footprintM: number): number {
  const nl = axis === 0 ? sign * LIGHT.x : axis === 1 ? sign * LIGHT.y : sign * LIGHT.z;
  const light = LIGHT.ambient + LIGHT.diffuse * (nl > 0 ? nl : 0);
  const u = axis === 0 ? py : px;
  const v = axis === 2 ? py : pz;
  const seed = kindCode * 31 + axis * 7 + (sign > 0 ? 3 : 0);
  return ALBEDO_BY_CODE[kindCode] * surfaceTexture(u, v, seed, footprintM) * light;
}

/** An emissive flame as an axis-aligned ellipsoid (radii rx = ry = r, rz) with peak emission `emission`. */
export interface FlameShape {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly r: number;
  readonly rz: number;
  readonly emission: number;
}

/** Flame shape from a fire's sphere and heat release (flame height as in the sensor model's fire sighting). */
export function flameShape(cx: number, cy: number, cz: number, radiusM: number, heatReleaseKW: number): FlameShape {
  const flameHeightM = Math.max(radiusM, 0.235 * heatReleaseKW ** 0.4 - 2.04 * radiusM);
  const rz = Math.max(radiusM, flameHeightM / 2);
  return { cx, cy, cz: cz - radiusM + rz, r: Math.max(0.05, radiusM), rz, emission: 1 + heatReleaseKW / 60 };
}

/**
 * Entry distance and chord fraction of a unit ray through a flame ellipsoid, written into out[0] (entry,
 * Infinity when missed) and out[1] (chord / longest chord, 0..1).
 */
export function flameChord(f: FlameShape, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, out: Float64Array): void {
  // Scale z so the ellipsoid becomes a sphere of radius r.
  const k = f.r / f.rz;
  const mx = ox - f.cx;
  const my = oy - f.cy;
  const mz = (oz - f.cz) * k;
  const ez = dz * k;
  const a = dx * dx + dy * dy + ez * ez;
  const b = mx * dx + my * dy + mz * ez;
  const c = mx * mx + my * my + mz * mz - f.r * f.r;
  const disc = b * b - a * c;
  if (disc <= 0 || a <= 0) {
    out[0] = Infinity;
    out[1] = 0;
    return;
  }
  const root = Math.sqrt(disc);
  const t0 = (-b - root) / a;
  const t1 = (-b + root) / a;
  if (t1 <= 0) {
    out[0] = Infinity;
    out[1] = 0;
    return;
  }
  out[0] = Math.max(0, t0);
  out[1] = Math.min(1, (root / a) * Math.sqrt(a) / f.r);
}

/**
 * Display encoding as a lookup table over gain·L in [0, 1] (encode(1) = 1, so larger values clamp): linear
 * interpolation between DISPLAY_LUT_SIZE samples, within 1e-3 of the exact power law except in the
 * steepest first sample cell near black.
 */
export function displayEncoder(gain: number, gamma: number): (linear: number) => number {
  const n = DISPLAY_LUT_SIZE;
  const table = new Float64Array(n + 2);
  for (let i = 0; i <= n + 1; i++) table[i] = Math.min(1, (i / n) ** (1 / gamma));
  return linear => {
    const scaled = gain * linear;
    if (!(scaled > 0)) return 0;
    if (scaled >= 1) return 1;
    const x = scaled * n;
    const i = x | 0;
    return table[i] + (table[i + 1] - table[i]) * (x - i);
  };
}

export const DISPLAY_LUT_SIZE = 4096;

/** Display encoding of the calibration: clamp((gain · L)^(1 / gamma), 0, 1). */
export function displayEncode(linear: number, gain: number, gamma: number): number {
  const scaled = gain * linear;
  if (!(scaled > 0)) return 0;
  const encoded = scaled ** (1 / gamma);
  return encoded >= 1 ? 1 : encoded;
}
