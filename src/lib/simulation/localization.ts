/**
 * Simulated localization error model — explicitly NOT SLAM or visual-inertial odometry. The simulator keeps
 * the estimate's error (driftM, yawDriftRad) and its one-sigma size (sigmaM, per horizontal axis) in
 * WorldState.estimator. Consumers only receive truth + drift + white jitter, never truth alone.
 *
 * Feature quality q ∈ [0, 1] is evaluated every featurePeriodTicks from what the aircraft's own sensors
 * could use at its true pose, with the same physics as the sensor models:
 *   range features  = mean expected lidar return probability over rangeRays horizontal rays (smoke
 *                     attenuated; oblique glass transparent);
 *   visual features = mean contrast exp(−τ) to the first surface within visualRangeM over a 3×3 camera grid
 *                     (glass counts as poor texture);
 *   q = 1 − (1 − range)·(1 − visual).
 * Every tick: σ ← σ_min + (σ + g·dt − σ_min)·exp(−(q/τ_c)·dt), with growth g = (1 − q)·(growthPerS +
 * growthPerM·speed). The drift contracts by the same factor and takes a keyed Gaussian step carrying the
 * variance the growth adds, so its spread tracks σ (approximately; the stationary variance is
 * σ·(σ − σ_min) ≈ σ²). Yaw uncertainty is derived: yawSigmaMinRad + yawSigmaPerM·σ.
 * supported ⇔ σ ≤ supportSigmaM = 0.75 m, the harness DEFAULT_POLICY.maxSigmaForAdvanceM.
 * Outdoors no GNSS is modelled: the same feature model applies everywhere.
 */
import type { SensorSpec } from "../contracts/aircraft.ts";
import { SIM_HZ, TICK_S } from "../contracts/clock.ts";
import type { Tick } from "../contracts/clock.ts";
import type { AircraftStatusEstimate, EstimatedPose, LandingSupport } from "../contracts/evidence.ts";
import type { Pose, Vec3 } from "../contracts/frames.ts";
import { norm, vec3, wrapAngle } from "../contracts/frames.ts";
import { opticalDepth, temperatureAt } from "./fire.ts";
import { keyedGaussian } from "./random.ts";
import { expectedLidarReturn } from "./sensors/lidar-ray.ts";
import { sensorDirection, sensorOrigin, truePose } from "./sensors/pose.ts";
import { ultrasoundEchoProbability, ultrasoundIgnores, ultrasoundRangeScale } from "./sensors/range-model.ts";
import type { TraceSet } from "./sensors/trace.ts";
import { crossSectionM, hitIncidenceCos, traceNearest, traceSet } from "./sensors/trace.ts";
import type { EstimatorState, WorldState } from "./world-state.ts";

export const LOCALIZATION_MODEL = Object.freeze({
  sigmaMinM: 0.05,
  supportSigmaM: 0.75,
  growthPerS: 0.01,
  growthPerM: 0.05,
  correctionTauS: 2,
  verticalFraction: 0.3,
  jitterM: 0.02,
  yawSigmaMinRad: 0.01,
  yawSigmaPerM: 0.05,
  velocityNoiseMps: 0.02,
  velocityNoiseNoFeaturesMps: 0.15,
  featurePeriodTicks: 5,
  rangeRays: 16,
  visualRangeM: 10,
  thermometerNoiseC: 0.3,
  /** Downward echoes must agree within this vertical spread for a flat landing surface. */
  landingFlatnessM: 0.05,
  landingMinEchoProbability: 0.5,
});

const RAD = Math.PI / 180;

export function initEstimator(): EstimatorState {
  return { driftM: vec3(0, 0, 0), yawDriftRad: 0, sigmaM: LOCALIZATION_MODEL.sigmaMinM, featureQuality: 1 };
}

export function updateEstimator(world: WorldState): void {
  const est = world.estimator;
  if (world.tick % LOCALIZATION_MODEL.featurePeriodTicks === 0) est.featureQuality = featureQuality(world);
  const q = Math.max(0, Math.min(1, est.featureQuality));
  const growthMps = (1 - q) * (LOCALIZATION_MODEL.growthPerS + LOCALIZATION_MODEL.growthPerM * norm(world.drone.velocity));
  const shrink = Math.exp(-(q / LOCALIZATION_MODEL.correctionTauS) * TICK_S);
  const before = est.sigmaM;
  const grown = before + growthMps * TICK_S;
  est.sigmaM = Math.max(LOCALIZATION_MODEL.sigmaMinM, LOCALIZATION_MODEL.sigmaMinM + (grown - LOCALIZATION_MODEL.sigmaMinM) * shrink);
  perturb(world, "localization/drift", shrink, before, grown);
}

export function estimatedPose(world: WorldState): EstimatedPose {
  const est = world.estimator;
  const drone = world.drone;
  const noise = (stream: string, index: number) => keyedGaussian(world.seed, stream, world.tick, index);
  const jitter = LOCALIZATION_MODEL.jitterM;
  const velocitySigma = LOCALIZATION_MODEL.velocityNoiseMps + (1 - Math.max(0, Math.min(1, est.featureQuality))) * LOCALIZATION_MODEL.velocityNoiseNoFeaturesMps;
  return {
    tick: world.tick,
    position: vec3(
      drone.position.x + est.driftM.x + jitter * noise("localization/jitter", 0),
      drone.position.y + est.driftM.y + jitter * noise("localization/jitter", 1),
      drone.position.z + est.driftM.z + LOCALIZATION_MODEL.verticalFraction * jitter * noise("localization/jitter", 2),
    ),
    yawRad: wrapAngle(drone.yawRad + est.yawDriftRad),
    velocity: vec3(
      drone.velocity.x + velocitySigma * noise("localization/velocity", 0),
      drone.velocity.y + velocitySigma * noise("localization/velocity", 1),
      drone.velocity.z + velocitySigma * noise("localization/velocity", 2),
    ),
    sigmaM: est.sigmaM,
    yawSigmaRad: yawSigma(est.sigmaM),
    supported: est.sigmaM <= LOCALIZATION_MODEL.supportSigmaM,
  };
}

/** Onboard instruments: battery gauge, flow meter, payload switches and a thermometer reading the local gas. */
export function aircraftStatus(world: WorldState): AircraftStatusEstimate {
  const drone = world.drone;
  const ambientC = temperatureAt(world, drone.position) + LOCALIZATION_MODEL.thermometerNoiseC * keyedGaussian(world.seed, "aircraft/thermometer", world.tick);
  return {
    enduranceRemainingS: Math.max(0, Math.floor(drone.enduranceRemainingS)),
    waterRemainingL: world.profile.modules.water === null ? null : Math.max(0, Math.floor(drone.waterRemainingL * 1000) / 1000),
    payloadsOnboard: [...drone.payloads],
    ambientC: Math.round(ambientC * 10) / 10,
    thrustAvailableN: drone.enduranceRemainingS > 0 ? world.profile.hardLimits.maxThrustN : 0,
  };
}

/**
 * Supported when the downward ultrasound's beam (centre plus four rays at half the beam angle) returns
 * confident echoes that agree within landingFlatnessM vertically. Evidence is the latest downward
 * ultrasound observation that has arrived; the echo geometry is evaluated at the current pose.
 */
export function landingSupport(world: WorldState): LandingSupport {
  const spec = world.profile.sensors.find(s => s.modality === "ultrasound" && s.mount.pitchRad > Math.PI / 4 && (s.maxRangeM ?? 0) > 0);
  if (!spec) return { supported: false, site: null, evidenceIds: [], reason: "No downward range sensor is fitted." };
  const captured = latestArrivedCapture(world.tick, spec);
  if (captured === null) return { supported: false, site: null, evidenceIds: [], reason: `No ${spec.id} echo has arrived yet.` };
  const evidenceIds = [`${world.runId}/${spec.id}/${captured}`];
  const drops = downwardDrops(world, spec);
  if (drops === null) return { supported: false, site: null, evidenceIds, reason: `${spec.id} has no confident echo across its beam within ${spec.maxRangeM} m.` };
  const spread = Math.max(...drops) - Math.min(...drops);
  if (spread > LOCALIZATION_MODEL.landingFlatnessM) return { supported: false, site: null, evidenceIds, reason: `${spec.id} echoes differ by ${spread.toFixed(2)} m: the surface below is not flat.` };
  const below = drops[0];
  const pose = estimatedPose(world);
  const site = vec3(pose.position.x, pose.position.y, pose.position.z + spec.mount.positionBody.z - below);
  return { supported: true, site, evidenceIds, reason: `${spec.id} sees a flat surface ${below.toFixed(2)} m below.` };
}

/** Experiment hook: inflate σ by sigmaIncreaseM and displace the estimate by a matching keyed random jump. */
export function degradeLocalization(world: WorldState, sigmaIncreaseM: number): void {
  if (!(sigmaIncreaseM >= 0) || !Number.isFinite(sigmaIncreaseM)) throw new RangeError(`Sigma increase must be a finite non-negative number, got ${sigmaIncreaseM}`);
  const est = world.estimator;
  const before = est.sigmaM;
  est.sigmaM = before + sigmaIncreaseM;
  perturb(world, "localization/degrade", 1, before, est.sigmaM);
}

function yawSigma(sigmaM: number): number {
  return LOCALIZATION_MODEL.yawSigmaMinRad + LOCALIZATION_MODEL.yawSigmaPerM * sigmaM;
}

/** Contract the error by `shrink`, then add keyed Gaussian steps carrying the variance from σ `before` → `after`. */
function perturb(world: WorldState, stream: string, shrink: number, before: number, after: number): void {
  const est = world.estimator;
  const g = (index: number) => keyedGaussian(world.seed, stream, world.tick, index);
  const step = Math.sqrt(Math.max(0, after * after - before * before));
  const yawStep = Math.sqrt(Math.max(0, yawSigma(after) ** 2 - yawSigma(before) ** 2));
  const d = est.driftM;
  est.driftM = vec3(d.x * shrink + step * g(0), d.y * shrink + step * g(1), d.z * shrink + LOCALIZATION_MODEL.verticalFraction * step * g(2));
  est.yawDriftRad = wrapAngle(est.yawDriftRad * shrink + yawStep * g(3));
}

function featureQuality(world: WorldState): number {
  const pose = truePose(world);
  const lidar = world.profile.sensors.find(s => s.modality === "lidar" && (s.maxRangeM ?? 0) > 0);
  const camera = world.profile.sensors.find(s => s.modality === "rgb" && s.horizontalFovDeg !== null && s.verticalFovDeg !== null);
  const range = lidar ? rangeFeatures(world, pose, lidar) : 0;
  const visual = camera ? visualFeatures(world, pose, camera) : 0;
  return 1 - (1 - range) * (1 - visual);
}

function rangeFeatures(world: WorldState, pose: Pose, spec: SensorSpec): number {
  const maxRangeM = spec.maxRangeM ?? 0;
  const origin = sensorOrigin(pose, spec);
  const set = traceSet(world, origin, maxRangeM);
  const fov = Math.min(360, spec.horizontalFovDeg ?? 360) * RAD;
  const count = LOCALIZATION_MODEL.rangeRays;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const azimuth = fov >= 2 * Math.PI ? (2 * Math.PI * i) / count : -fov / 2 + (fov * (i + 0.5)) / count;
    sum += expectedLidarReturn(world, set, origin, sensorDirection(pose, spec, azimuth, 0), maxRangeM);
  }
  return sum / count;
}

function visualFeatures(world: WorldState, pose: Pose, spec: SensorSpec): number {
  const origin = sensorOrigin(pose, spec);
  const reach = LOCALIZATION_MODEL.visualRangeM;
  const set = traceSet(world, origin, reach);
  const h = ((spec.horizontalFovDeg ?? 0) * RAD) / 3;
  const v = ((spec.verticalFovDeg ?? 0) * RAD) / 3;
  let sum = 0;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) sum += surfaceContrast(world, set, origin, sensorDirection(pose, spec, i * h, j * v), reach);
  }
  return sum / 9;
}

function surfaceContrast(world: WorldState, set: TraceSet, origin: Vec3, dir: Vec3, reach: number): number {
  const index = traceNearest(set, origin, dir, reach);
  if (index < 0) return 0;
  const t = set.distance;
  const texture = set.colliders[index].kind === "glass" ? 0.3 : 1;
  return texture * Math.exp(-opticalDepth(world, origin, vec3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t)));
}

/** Vertical drop to the surface for the beam centre and four rays at half the beam angle; null if any lacks a confident echo. */
function downwardDrops(world: WorldState, spec: SensorSpec): number[] | null {
  const pose = truePose(world);
  const maxRangeM = spec.maxRangeM ?? 0;
  const origin = sensorOrigin(pose, spec);
  const set = traceSet(world, origin, maxRangeM);
  const half = (((spec.horizontalFovDeg ?? 30) * RAD) / 2) * 0.5;
  const angles: readonly (readonly [number, number])[] = [[0, 0], [half, 0], [-half, 0], [0, half], [0, -half]];
  const scale = ultrasoundRangeScale(temperatureAt(world, origin));
  const drops: number[] = [];
  for (const [azimuth, elevation] of angles) {
    const dir = sensorDirection(pose, spec, azimuth, elevation);
    const index = traceNearest(set, origin, dir, maxRangeM, collider => ultrasoundIgnores(crossSectionM(collider, dir)));
    if (index < 0) return null;
    const t = set.distance;
    const hit = vec3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
    const p = ultrasoundEchoProbability(set.colliders[index].kind, t, opticalDepth(world, origin, hit), maxRangeM, hitIncidenceCos(set, index, origin, dir, t));
    if (p < LOCALIZATION_MODEL.landingMinEchoProbability) return null;
    drops.push(t * scale * -dir.z);
  }
  return drops;
}

function latestArrivedCapture(tick: Tick, spec: SensorSpec): Tick | null {
  const period = Math.max(1, Math.round(SIM_HZ / spec.rateHz));
  const latest = Math.floor((tick - spec.latencyTicks) / period) * period;
  return latest >= 0 ? latest : null;
}
