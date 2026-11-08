/**
 * Conventional optical-flow cues for the flow baseline (not fly-model inference).
 *
 * 1. Derotation: subtract the image motion predicted for the previous executed yaw rate (efference copy)
 *    through the camera's pitch, so turning does not masquerade as nearness.
 * 2. Centering: weighted mean outward horizontal flow in the left and right peripheral regions
 *    (|azimuth| ≥ 25°). Angular speed scales with speed/distance, so the normalised imbalance
 *    (L − R)/(L + R) points to the nearer side independently of speed (honeybee-style corridor balance).
 * 3. Looming: a robust (Huber-IRLS) affine fit of the translational flow in a central window around the
 *    forward direction (±12° × ±10°). Its divergence is 2/τ for a surface ahead, so 1/τ = div/2.
 * 4. Avoidance hint: looming rate per frontal sector (left/right of the forward direction, out to ±20°),
 *    least-squares fitted as outward flow = ρ·|x| (pure expansion about the forward direction), then
 *    (ρR − ρL)/(ρR + ρL + floor), gated by significance. Dividing out eccentricity keeps the cue usable at
 *    the low speeds where it matters (approaching an obstacle that blocks one side).
 */
import type { FlowField, FlowPrior } from "./flow.ts";
import type { CameraModel, ReflexCues } from "./types.ts";
import { focalLengthPx } from "./types.ts";

export interface FlowCueConfig {
  /** Central (looming) window half-extents as tangents of the angle from the forward direction. */
  readonly centralHalfWidth: number;
  readonly centralHalfHeight: number;
  /** Peripheral regions start at this tangent of azimuth on each side. */
  readonly lateralInner: number;
  /** Frontal avoidance sectors extend to this tangent of azimuth on each side (same rows as the central window). */
  readonly sectorOuter: number;
  /** Minimum summed vector weight for a region estimate. */
  readonly minRegionWeight: number;
}

const RAD = Math.PI / 180;

export const DEFAULT_FLOW_CUE_CONFIG: FlowCueConfig = Object.freeze({
  centralHalfWidth: Math.tan(12 * RAD),
  centralHalfHeight: Math.tan(10 * RAD),
  lateralInner: Math.tan(25 * RAD),
  sectorOuter: Math.tan(20 * RAD),
  minRegionWeight: 25,
});

/** Noise floor of a sector looming rate (s⁻¹), from static and rotating synthetic scenes at 50 Hz. */
const SECTOR_FLOOR_HZ = 0.1;

export interface FlowCueResult {
  readonly cues: ReflexCues;
  /** Finite diagnostics; rates in s⁻¹ of normalised image coordinates. */
  readonly features: Readonly<Record<string, number>>;
}

/** Points for a weighted affine flow fit, in normalised image coordinates per frame. */
interface FitData {
  readonly x: number[];
  readonly y: number[];
  readonly u: number[];
  readonly v: number[];
  readonly w: number[];
}

interface Affine {
  readonly u: readonly [number, number, number];
  readonly v: readonly [number, number, number];
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
const smoothstep = (value: number, lo: number, hi: number): number => {
  const t = clamp01((value - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
};

/** Solve the symmetric 3×3 system m·a = r (row-major m) by Cramer's rule; null when singular. */
function solve3(m: readonly number[], r: readonly number[]): [number, number, number] | null {
  const det3 = (a: readonly number[]) => a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  const det = det3(m);
  if (!(Math.abs(det) > 1e-18)) return null;
  const column = (k: number) => m.map((value, index) => (index % 3 === k ? r[Math.floor(index / 3)] : value));
  return [det3(column(0)) / det, det3(column(1)) / det, det3(column(2)) / det];
}

function fitAffine(d: FitData, factors: readonly number[]): Affine | null {
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const ru = [0, 0, 0];
  const rv = [0, 0, 0];
  for (let i = 0; i < d.w.length; i++) {
    const w = d.w[i] * factors[i];
    const basis = [1, d.x[i], d.y[i]];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) m[a * 3 + b] += w * basis[a] * basis[b];
      ru[a] += w * basis[a] * d.u[i];
      rv[a] += w * basis[a] * d.v[i];
    }
  }
  const u = solve3(m, ru);
  const v = solve3(m, rv);
  return u && v ? { u, v } : null;
}

/** Two Huber reweighting rounds (k = 1.5 × robust residual scale) after an initial weighted fit. */
function robustAffine(d: FitData): Affine | null {
  const factors = d.w.map(() => 1);
  let fit = fitAffine(d, factors);
  for (let round = 0; round < 2 && fit; round++) {
    const current = fit;
    const residuals = d.w.map((_, i) => Math.hypot(d.u[i] - (current.u[0] + current.u[1] * d.x[i] + current.u[2] * d.y[i]), d.v[i] - (current.v[0] + current.v[1] * d.x[i] + current.v[2] * d.y[i])));
    const totalWeight = d.w.reduce((sum, w) => sum + w, 0);
    const scale = (1.25 * residuals.reduce((sum, r, i) => sum + r * d.w[i], 0)) / totalWeight + 1e-9;
    residuals.forEach((r, i) => { factors[i] = r <= 1.5 * scale ? 1 : (1.5 * scale) / r; });
    fit = fitAffine(d, factors);
  }
  return fit;
}

/** Weighted sums: lateral outward flow (value, weight) and frontal sector expansion fits (Σw·x·u, Σw·x²). */
interface Sums { left: number; leftW: number; right: number; rightW: number; sectorLeft: number; sectorLeftW: number; sectorRight: number; sectorRightW: number; total: number }

function accumulate(sums: Sums, side: "left" | "right" | "sectorLeft" | "sectorRight", value: number, w: number): void {
  sums[side] += value;
  sums[`${side}W`] += w;
}

/**
 * Image displacement (grid pixels over dtS) that a body yaw rate produces through a camera pitched down by
 * camera.pitchRad: Ω_optical = (0, −ω·cos p, −ω·sin p) in the rotational motion-field equations
 * u = −Ωy(1 + x²) + Ωz·y, v = −Ωy·x·y − Ωz·x (normalised coordinates, Ωx = 0). Positive yaw (left) moves
 * the image to the right.
 */
export function predictedRotationFlow(width: number, height: number, camera: CameraModel, dtS: number, yawRateRadps: number): FlowPrior {
  const f = focalLengthPx(camera, width);
  const wc = yawRateRadps * Math.cos(camera.pitchRad);
  const ws = yawRateRadps * Math.sin(camera.pitchRad);
  const u = new Float32Array(width * height);
  const v = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    const y = (row + 0.5 - height / 2) / f;
    for (let col = 0; col < width; col++) {
      const x = (col + 0.5 - width / 2) / f;
      u[row * width + col] = f * dtS * (wc * (1 + x * x) - ws * y);
      v[row * width + col] = f * dtS * (wc * x * y + ws * x);
    }
  }
  return { u, v };
}

/** Compute centering, looming and avoidance cues from one flow field (grid pixels per frame interval). */
export function computeFlowCues(field: FlowField, camera: CameraModel, dtS: number, yawRateRadps: number, config: FlowCueConfig = DEFAULT_FLOW_CUE_CONFIG): FlowCueResult {
  if (!(dtS > 0)) throw new RangeError(`Frame interval must be positive, got ${dtS}`);
  const { width, height } = field;
  const f = focalLengthPx(camera, width);
  const yForward = -Math.tan(camera.pitchRad);
  const rotation = predictedRotationFlow(width, height, camera, dtS, yawRateRadps);
  const sums: Sums = { left: 0, leftW: 0, right: 0, rightW: 0, sectorLeft: 0, sectorLeftW: 0, sectorRight: 0, sectorRightW: 0, total: 0 };
  const fit: FitData = { x: [], y: [], u: [], v: [], w: [] };
  for (let row = 0; row < height; row++) {
    const y = (row + 0.5 - height / 2) / f;
    const central = Math.abs(y - yForward) <= config.centralHalfHeight;
    for (let col = 0; col < width; col++) {
      const p = row * width + col;
      const w = field.weight[p];
      if (!(w > 0)) continue;
      const x = (col + 0.5 - width / 2) / f;
      // Translational flow in normalised coordinates per frame after removing predicted yaw flow.
      const ut = (field.u[p] - rotation.u[p]) / f;
      const vt = (field.v[p] - rotation.v[p]) / f;
      sums.total += w;
      if (x <= -config.lateralInner) accumulate(sums, "left", -w * ut, w);
      else if (x >= config.lateralInner) accumulate(sums, "right", w * ut, w);
      if (!central) continue;
      // Expansion fit through the forward direction: x·ut > 0 for outward flow on either side.
      if (Math.abs(x) <= config.sectorOuter) accumulate(sums, x < 0 ? "sectorLeft" : "sectorRight", w * x * ut, w * x * x);
      if (Math.abs(x) > config.centralHalfWidth) continue;
      fit.x.push(x);
      fit.y.push(y - yForward);
      fit.u.push(ut);
      fit.v.push(vt);
      fit.w.push(w);
    }
  }
  return assemble(sums, fit, dtS, field, config);
}

function assemble(sums: Sums, fit: FitData, dtS: number, field: FlowField, config: FlowCueConfig): FlowCueResult {
  const min = config.minRegionWeight;
  const leftHz = sums.leftW >= min ? Math.max(0, sums.left / sums.leftW / dtS) : 0;
  const rightHz = sums.rightW >= min ? Math.max(0, sums.right / sums.rightW / dtS) : 0;
  const bothSides = sums.leftW >= min && sums.rightW >= min;
  const centering = bothSides ? (leftHz - rightHz) / (leftHz + rightHz + 0.02) : 0;
  const centeringWeight = bothSides ? smoothstep(leftHz + rightHz, 0.03, 0.15) : 0;
  const centralWeight = fit.w.reduce((sum, w) => sum + w, 0);
  const affine = centralWeight >= min ? robustAffine(fit) : null;
  const divergenceHz = affine ? (affine.u[1] + affine.v[2]) / dtS : 0;
  const loomingRateHz = affine ? Math.max(0, divergenceHz / 2) : null;
  // Σw·x² is tiny for a sector without usable vectors; require the equivalent of ~min/4 vectors at |x| = 0.15.
  const minSector = (min / 4) * 0.15 * 0.15;
  const loomLeft = sums.sectorLeftW >= minSector ? Math.max(0, sums.sectorLeft / sums.sectorLeftW / dtS) : 0;
  const loomRight = sums.sectorRightW >= minSector ? Math.max(0, sums.sectorRight / sums.sectorRightW / dtS) : 0;
  const avoidRatio = (loomRight - loomLeft) / (loomRight + loomLeft + SECTOR_FLOOR_HZ);
  const avoidTurn = affine ? avoidRatio * smoothstep(Math.max(loomLeft, loomRight), SECTOR_FLOOR_HZ, 3 * SECTOR_FLOOR_HZ) : 0;
  const visualConfidence = clamp01(sums.total / (0.5 * field.width * field.height));
  const cues: ReflexCues = { visualConfidence, centering, centeringWeight, loomingRateHz, avoidTurn };
  const features = {
    validFraction: field.validFraction,
    contrast: field.contrast,
    flowLeftHz: leftHz,
    flowRightHz: rightHz,
    centralWeight,
    divergenceHz,
    tauS: loomingRateHz && loomingRateHz > 0.01 ? Math.min(100, 1 / loomingRateHz) : 100,
    loomLeftHz: loomLeft,
    loomRightHz: loomRight,
  };
  return { cues, features };
}
