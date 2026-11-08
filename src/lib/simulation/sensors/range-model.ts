/**
 * Synthetic range-sensor physics shared by the lidar/ultrasound models and the localization error model.
 * Documented engineering assumptions: not sensor hardware validation and not the published Saranga echo
 * model (these are simulated range rays).
 *
 * Lidar (near-infrared time of flight, narrow beam):
 * - SNR = (ρ / ρ_ref)·(R_max / d)²·exp(−2·τ_NIR)·max(cos θ, 0.2): a 10 % target at maximum range in clear
 *   air has SNR 1. Detection probability SNR² / (1 + SNR²), times (1 − dropout).
 * - Smoke: τ_NIR = lidarSmokeFactor·τ_visible (soot extinction falls roughly as 1/λ, 0.63 → 0.9 µm ≈ 0.7;
 *   0.6 assumed). Dense smoke (K_NIR above lidarFalseReturnMinK at the sensor) also returns false early
 *   echoes (backscatter): per-ray probability min(falseReturnMax, falseReturnPerK·K_NIR), at a distance
 *   uniform between the minimum range and min(true hit, 1.5 / K_NIR).
 * - Glass is transparent at oblique incidence (the ray continues to whatever is behind it) and returns only
 *   near the normal (|cos θ| ≥ lidarGlassMinCos).
 * - Range noise σ = 0.01 m + 0.02 m / max(SNR, 0.5).
 *
 * Ultrasound (40 kHz class, ~30° beam):
 * - Echo SNR = (ρ_ac / 0.3)·(R_max / d)²·exp(−2·ultrasoundSmokeFactor·τ_visible)·specular(θ); smooth
 *   surfaces reflect the pulse away beyond ~70° incidence. Detection SNR² / (1 + SNR²) × (1 − dropout).
 * - Far less smoke-sensitive than light (soot barely scatters sound; the small factor stands in for hot,
 *   turbulent gas) but noisier: σ = 0.02 + 0.01·d + 0.0005·(T − 20 °C)·d, and hot gas biases ranges short
 *   (speed of sound ∝ √T, so d_measured = d·√(293 K / T)).
 * - Thin obstacles (cross-section < ultrasoundThinM: glass edges, table legs) return no usable echo.
 */
import type { ColliderKind } from "../../contracts/scene.ts";

export const RANGE_MODEL = Object.freeze({
  minRangeM: 0.05,
  lidarSmokeFactor: 0.6,
  lidarReferenceReflectivity: 0.1,
  lidarDropout: 0.01,
  lidarGlassMinCos: 0.95,
  lidarFalseReturnPerK: 0.08,
  lidarFalseReturnMax: 0.35,
  /** NIR extinction (1/m) below which backscatter never registers (≈1.5/m visible, visibility ≈ 2 m). */
  lidarFalseReturnMinK: 0.9,
  ultrasoundSmokeFactor: 0.05,
  ultrasoundReferenceReflectivity: 0.3,
  ultrasoundDropout: 0.05,
  ultrasoundThinM: 0.05,
  ultrasoundSpecularCosLow: Math.cos((70 * Math.PI) / 180),
  ultrasoundSpecularCosHigh: Math.cos((25 * Math.PI) / 180),
});

/** Near-infrared diffuse reflectivity by collider kind (assumed). Glass is handled separately. */
const LIDAR_REFLECTIVITY: { readonly [kind in ColliderKind]: number } = {
  ground: 0.25, wall: 0.6, floor: 0.4, ceiling: 0.6, roof: 0.3, stair: 0.4, furniture: 0.4, glass: 0.3, door: 0.5, tree: 0.3, street_furniture: 0.3,
};

/** Acoustic reflectivity by collider kind (assumed; upholstery and foliage absorb). */
const ULTRASOUND_REFLECTIVITY: { readonly [kind in ColliderKind]: number } = {
  ground: 0.8, wall: 0.95, floor: 0.9, ceiling: 0.95, roof: 0.9, stair: 0.7, furniture: 0.5, glass: 0.98, door: 0.9, tree: 0.25, street_furniture: 0.7,
};

export function detectionProbability(snr: number, dropout: number): number {
  if (!(snr > 0)) return 0;
  return ((snr * snr) / (1 + snr * snr)) * (1 - dropout);
}

export function lidarSnr(kind: ColliderKind, distanceM: number, tauVisible: number, maxRangeM: number, cosIncidence: number): number {
  const d = Math.max(distanceM, RANGE_MODEL.minRangeM);
  const geometric = (maxRangeM / d) ** 2;
  const smoke = Math.exp(-2 * RANGE_MODEL.lidarSmokeFactor * tauVisible);
  return (LIDAR_REFLECTIVITY[kind] / RANGE_MODEL.lidarReferenceReflectivity) * geometric * smoke * Math.max(cosIncidence, 0.2);
}

/** Expected probability that a lidar ray returns from a surface; glass at oblique incidence never does. */
export function lidarReturnProbability(kind: ColliderKind, distanceM: number, tauVisible: number, maxRangeM: number, cosIncidence: number): number {
  if (kind === "glass" && !lidarSeesGlass(cosIncidence)) return 0;
  return detectionProbability(lidarSnr(kind, distanceM, tauVisible, maxRangeM, cosIncidence), RANGE_MODEL.lidarDropout);
}

export function lidarSeesGlass(cosIncidence: number): boolean {
  return cosIncidence >= RANGE_MODEL.lidarGlassMinCos;
}

export function lidarRangeSigmaM(snr: number): number {
  return 0.01 + 0.02 / Math.max(snr, 0.5);
}

/** Per-ray probability of a false early return from smoke backscatter, given NIR extinction at the sensor. */
export function lidarFalseReturnProbability(nirExtinctionPerM: number): number {
  if (!(nirExtinctionPerM > RANGE_MODEL.lidarFalseReturnMinK)) return 0;
  return Math.min(RANGE_MODEL.lidarFalseReturnMax, RANGE_MODEL.lidarFalseReturnPerK * nirExtinctionPerM);
}

export function ultrasoundSnr(kind: ColliderKind, distanceM: number, tauVisible: number, maxRangeM: number, cosIncidence: number): number {
  const d = Math.max(distanceM, RANGE_MODEL.minRangeM);
  const span = RANGE_MODEL.ultrasoundSpecularCosHigh - RANGE_MODEL.ultrasoundSpecularCosLow;
  const specular = Math.max(0, Math.min(1, (cosIncidence - RANGE_MODEL.ultrasoundSpecularCosLow) / span));
  const smoke = Math.exp(-2 * RANGE_MODEL.ultrasoundSmokeFactor * tauVisible);
  return (ULTRASOUND_REFLECTIVITY[kind] / RANGE_MODEL.ultrasoundReferenceReflectivity) * (maxRangeM / d) ** 2 * smoke * specular;
}

export function ultrasoundEchoProbability(kind: ColliderKind, distanceM: number, tauVisible: number, maxRangeM: number, cosIncidence: number): number {
  return detectionProbability(ultrasoundSnr(kind, distanceM, tauVisible, maxRangeM, cosIncidence), RANGE_MODEL.ultrasoundDropout);
}

export function ultrasoundRangeSigmaM(distanceM: number, gasC: number): number {
  return 0.02 + 0.01 * distanceM + 0.0005 * Math.max(0, gasC - 20) * distanceM;
}

/** Multiplicative range bias from the speed of sound in gas at gasC (calibrated for 20 °C). */
export function ultrasoundRangeScale(gasC: number): number {
  return Math.sqrt(293.15 / Math.max(173.15, gasC + 273.15));
}

export function ultrasoundIgnores(crossSectionM: number): boolean {
  return crossSectionM < RANGE_MODEL.ultrasoundThinM;
}
