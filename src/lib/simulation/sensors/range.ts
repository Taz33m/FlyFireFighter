/**
 * Lidar and ultrasound captures (physics in range-model.ts): an observation for the belief — a geometry
 * coverage footprint with personSearch null, because range data establishes geometry, never the absence of
 * people — plus the raw returns that feed the motion controllers' range readings.
 *
 * Lidar: at most maxRays beams over the horizontal FOV (the spec's 360-column resolution is subsampled to
 * bound cost). Per beam: the first returnable surface (oblique glass is transparent), a keyed detection draw
 * against the return probability, keyed Gaussian range noise, and a possible false early return from smoke
 * backscatter that replaces the reading when nearer (first-return output, as on a real sensor). Quality =
 * share of beams with a detected surface return (backscatter is weak and fails the validity check).
 * Footprint: footprintCones azimuth cones (10° cells, 5° half-angle), each cut at the nearest reading in its
 * cell. A missed return is not free space: the beam probed no further than the surface it reached (too dark,
 * too oblique or too far to return), so a miss is cut there, or earlier where a missing return stops being
 * informative (missTauLimit of visible optical depth); only a beam that reached no surface within range
 * supports free space out to that limit.
 *
 * Ultrasound: the ~30° beam is sampled by subRays rays; thin obstacles give no echo; each ray is drawn
 * against its echo probability and the nearest echo is the reading, scaled by the hot-gas speed-of-sound
 * bias plus keyed noise. Footprint: one sector over the beam cut at the reading (or the supported range).
 * Quality = share of the beam returning an echo (an echo-strength proxy).
 */
import type { SensorSpec } from "../../contracts/aircraft.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { vec3, wrapAngle } from "../../contracts/frames.ts";
import type { Region } from "../../contracts/geometry.ts";
import { sector, union } from "../../contracts/geometry.ts";
import type { Observation } from "../../contracts/observation.ts";
import { extinctionAt, opticalDepth, temperatureAt, visibilityAlong } from "../fire.ts";
import { keyedGaussian, keyedUniform } from "../random.ts";
import { lidarSurface } from "./lidar-ray.ts";
import type { SenseContext } from "./observation.ts";
import { buildObservation } from "./observation.ts";
import { sensorDirection, sensorOrigin } from "./pose.ts";
import { detectionProbability, lidarFalseReturnProbability, lidarRangeSigmaM, lidarSnr, RANGE_MODEL, ultrasoundEchoProbability, ultrasoundIgnores, ultrasoundRangeScale, ultrasoundRangeSigmaM } from "./range-model.ts";
import { coneDirections } from "./shapes.ts";
import type { TraceSet } from "./trace.ts";
import { crossSectionM, hitIncidenceCos, traceNearest, traceSet } from "./trace.ts";

export const LIDAR_MODEL = Object.freeze({ maxRays: 120, footprintCones: 36, missTauLimit: 1.9 });
export const ULTRASOUND_MODEL = Object.freeze({ subRays: 9, missTauLimit: 23 });

/** One measured range in the body frame: azimuth left-positive from forward, elevation up-positive. */
export interface RangeReturn {
  readonly azimuthBodyRad: number;
  readonly elevationBodyRad: number;
  readonly rangeM: number;
}

export interface RangeCapture {
  readonly observation: Observation;
  readonly returns: readonly RangeReturn[];
}

const RAD = Math.PI / 180;

export function lidarCapture(ctx: SenseContext, spec: SensorSpec): RangeCapture {
  const maxRangeM = spec.maxRangeM ?? 0;
  const origin = sensorOrigin(ctx.truth, spec);
  const set = traceSet(ctx.world, origin, maxRangeM);
  const fov = Math.min(360, spec.horizontalFovDeg ?? 360) * RAD;
  const count = Math.max(1, Math.min(LIDAR_MODEL.maxRays, spec.resolution?.width ?? LIDAR_MODEL.maxRays));
  const nirAtSensor = RANGE_MODEL.lidarSmokeFactor * extinctionAt(ctx.world, origin);
  const supported = new Float64Array(count);
  const returns: RangeReturn[] = [];
  let valid = 0;
  for (let i = 0; i < count; i++) {
    const azimuth = -fov / 2 + ((i + 0.5) * fov) / count;
    const beam = lidarBeam(ctx, spec, set, origin, azimuth, nirAtSensor, i);
    supported[i] = beam.supportedM;
    if (beam.valid) valid += 1;
    if (beam.readingM !== null) returns.push({ azimuthBodyRad: wrapAngle(spec.mount.yawRad + azimuth), elevationBodyRad: -spec.mount.pitchRad, rangeM: beam.readingM });
  }
  const footprint = lidarFootprint(ctx, spec, fov, supported);
  return { observation: buildObservation(ctx, spec, { quality: valid / count, footprint, personSearch: null, detections: [] }), returns };
}

function lidarBeam(ctx: SenseContext, spec: SensorSpec, set: TraceSet, origin: Vec3, azimuth: number, nirAtSensor: number, index: number): { readonly readingM: number | null; readonly supportedM: number; readonly valid: boolean } {
  const { seed } = ctx.world;
  const maxRangeM = spec.maxRangeM ?? 0;
  const dir = sensorDirection(ctx.truth, spec, azimuth, 0);
  const surface = lidarSurface(ctx.world, set, origin, dir, maxRangeM);
  let readingM: number | null = null;
  if (surface) {
    const snr = lidarSnr(surface.collider.kind, surface.distanceM, surface.tauVisible, maxRangeM, surface.cosIncidence);
    if (keyedUniform(seed, `${spec.id}/return`, ctx.tick, index) < detectionProbability(snr, RANGE_MODEL.lidarDropout)) {
      readingM = Math.max(RANGE_MODEL.minRangeM, surface.distanceM + lidarRangeSigmaM(snr) * keyedGaussian(seed, `${spec.id}/range`, ctx.tick, index));
    }
  }
  const valid = readingM !== null;
  const falseM = backscatterReturn(ctx, spec, nirAtSensor, readingM ?? maxRangeM, index);
  if (falseM !== null && (readingM === null || falseM < readingM)) readingM = falseM;
  const supportedM = readingM ?? Math.min(surface?.distanceM ?? maxRangeM, visibilityAlong(ctx.world, origin, dir, maxRangeM, LIDAR_MODEL.missTauLimit).distanceM);
  return { readingM, supportedM, valid };
}

function backscatterReturn(ctx: SenseContext, spec: SensorSpec, nirAtSensor: number, beyondM: number, index: number): number | null {
  const p = lidarFalseReturnProbability(nirAtSensor);
  if (!(p > 0) || keyedUniform(ctx.world.seed, `${spec.id}/backscatter`, ctx.tick, index) >= p) return null;
  const farM = Math.min(beyondM, 1.5 / nirAtSensor);
  return RANGE_MODEL.minRangeM + keyedUniform(ctx.world.seed, `${spec.id}/backscatter-range`, ctx.tick, index) * Math.max(0, farM - RANGE_MODEL.minRangeM);
}

function lidarFootprint(ctx: SenseContext, spec: SensorSpec, fov: number, supported: Float64Array): Region {
  const cones = Math.min(LIDAR_MODEL.footprintCones, supported.length);
  const cuts = new Array<number>(cones).fill(Infinity);
  for (let i = 0; i < supported.length; i++) {
    const cell = Math.min(cones - 1, Math.floor(((i + 0.5) / supported.length) * cones));
    cuts[cell] = Math.min(cuts[cell], supported[i]);
  }
  const apex = sensorOrigin(ctx.estimatePose, spec);
  const halfAngle = fov / cones / 2;
  return union(cuts.map((cut, c) => sector(apex, sensorDirection(ctx.estimatePose, spec, -fov / 2 + ((c + 0.5) * fov) / cones, 0), halfAngle, Number.isFinite(cut) ? cut : 0)));
}

export function ultrasoundCapture(ctx: SenseContext, spec: SensorSpec): RangeCapture {
  const maxRangeM = spec.maxRangeM ?? 0;
  const origin = sensorOrigin(ctx.truth, spec);
  const set = traceSet(ctx.world, origin, maxRangeM);
  const halfAngle = ((spec.horizontalFovDeg ?? 30) * RAD) / 2;
  const axis = sensorDirection(ctx.truth, spec, 0, 0);
  const rays = coneDirections(axis, halfAngle, ULTRASOUND_MODEL.subRays);
  let echoM = Infinity;
  let echoes = 0;
  rays.forEach((dir, j) => {
    const d = subRayEcho(ctx, spec, set, origin, dir, j);
    if (d === null) return;
    echoes += 1;
    echoM = Math.min(echoM, d);
  });
  const readingM = Number.isFinite(echoM) ? measuredEcho(ctx, spec, origin, echoM) : null;
  const supportedM = readingM ?? visibilityAlong(ctx.world, origin, axis, maxRangeM, ULTRASOUND_MODEL.missTauLimit).distanceM;
  const footprint = union([sector(sensorOrigin(ctx.estimatePose, spec), sensorDirection(ctx.estimatePose, spec, 0, 0), halfAngle, supportedM)]);
  const returns = readingM === null ? [] : [{ azimuthBodyRad: wrapAngle(spec.mount.yawRad), elevationBodyRad: -spec.mount.pitchRad, rangeM: readingM }];
  return { observation: buildObservation(ctx, spec, { quality: echoes / rays.length, footprint, personSearch: null, detections: [] }), returns };
}

function subRayEcho(ctx: SenseContext, spec: SensorSpec, set: TraceSet, origin: Vec3, dir: Vec3, index: number): number | null {
  const maxRangeM = spec.maxRangeM ?? 0;
  const hitIndex = traceNearest(set, origin, dir, maxRangeM, collider => ultrasoundIgnores(crossSectionM(collider, dir)));
  if (hitIndex < 0) return null;
  const t = set.distance;
  const hit = vec3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
  const p = ultrasoundEchoProbability(set.colliders[hitIndex].kind, t, opticalDepth(ctx.world, origin, hit), maxRangeM, hitIncidenceCos(set, hitIndex, origin, dir, t));
  return keyedUniform(ctx.world.seed, `${spec.id}/echo`, ctx.tick, index) < p ? t : null;
}

function measuredEcho(ctx: SenseContext, spec: SensorSpec, origin: Vec3, trueM: number): number {
  const gasC = temperatureAt(ctx.world, origin);
  const noisy = trueM * ultrasoundRangeScale(gasC) + ultrasoundRangeSigmaM(trueM, gasC) * keyedGaussian(ctx.world.seed, `${spec.id}/range`, ctx.tick);
  return Math.max(RANGE_MODEL.minRangeM, Math.min(spec.maxRangeM ?? noisy, noisy));
}
