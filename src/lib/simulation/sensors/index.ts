/**
 * Synthetic sensor suite for the twin. senseTick(world) is a pure read of the world (it never mutates it):
 * for every sensor whose cadence (period = SIM_HZ / rateHz ticks) hits world.tick it returns an observation
 * (id `${runId}/${sensorId}/${tick}`, captureTick = tick, arrivalTick = tick + latencyTicks, provenance
 * "simulated_sensor", sensorPose from estimatedPose), plus — on ticks when range sensors fire — the range
 * readings motion controllers use, and the IMU reading. Randomness is keyed by (world seed, sensor stream,
 * tick, index), so the same world and tick always give the same frame.
 *
 * Cameras run their person search (possible-person oracle and depth-image footprint) at PERSON_SEARCH_HZ
 * (observation.ts); a faster camera's other frames carry personSearch null and no footprint.
 *
 * Range readings are the minima of this tick's returns in body sectors: forward |azimuth| ≤ 30°, left
 * 60°–120°, right −120°…−60°, down = elevation below −45°; null when no return fell in the sector (including
 * when no sensor covering it fired this tick). They become usable at arrivalTick (the slowest contributing
 * latency); the caller buffers them like observations.
 *
 * IMU: gyro = true yaw rate + keyed noise; accelerometer = gravity + keyed noise only, because the truth
 * state carries no acceleration (dynamic specific force is not modelled; see the localization error model).
 */
import type { SensorSpec } from "../../contracts/aircraft.ts";
import type { Tick } from "../../contracts/clock.ts";
import { onCadence } from "../../contracts/clock.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { vec3 } from "../../contracts/frames.ts";
import type { Observation } from "../../contracts/observation.ts";
import { keyedGaussian } from "../random.ts";
import type { WorldState } from "../world-state.ts";
import type { SenseContext } from "./observation.ts";
import { buildObservation, senseContext, sensorPeriodTicks } from "./observation.ts";
import type { RangeReturn } from "./range.ts";
import { lidarCapture, ultrasoundCapture } from "./range.ts";
import { rgbObservation } from "./rgb.ts";
import { thermalObservation } from "./thermal.ts";

export interface RangeReadings {
  readonly captureTick: Tick;
  readonly arrivalTick: Tick;
  readonly forwardM: number | null;
  readonly leftM: number | null;
  readonly rightM: number | null;
  readonly downM: number | null;
}

export interface ImuReading {
  readonly captureTick: Tick;
  readonly arrivalTick: Tick;
  /** Body-frame angular rate, rad/s. */
  readonly angularRateRadps: Vec3;
  /** Body-frame specific force, m/s² (gravity reads +9.81 on Z when level). */
  readonly specificForceMps2: Vec3;
}

export interface SensorFrame {
  readonly tick: Tick;
  readonly observations: readonly Observation[];
  readonly ranges: RangeReadings | null;
  readonly imu: ImuReading | null;
}

export { PERSON_SEARCH_HZ, sensorPeriodTicks } from "./observation.ts";

export const IMU_MODEL = Object.freeze({ gyroNoiseRadps: 0.005, accelNoiseMps2: 0.05, gravityMps2: 9.81 });

const RAD = Math.PI / 180;

export function senseTick(world: WorldState): SensorFrame {
  const ctx = senseContext(world);
  const observations: Observation[] = [];
  const returns: RangeReturn[] = [];
  let rangeLatency = -1;
  let imu: ImuReading | null = null;
  for (const spec of world.profile.sensors) {
    if (!onCadence(world.tick, sensorPeriodTicks(spec))) continue;
    const captured = capture(ctx, spec);
    observations.push(captured.observation);
    if (captured.returns) {
      returns.push(...captured.returns);
      rangeLatency = Math.max(rangeLatency, spec.latencyTicks);
    }
    if (captured.imu) imu = captured.imu;
  }
  return { tick: world.tick, observations, ranges: rangeLatency < 0 ? null : summarizeRanges(returns, world.tick, rangeLatency), imu };
}

interface Capture {
  readonly observation: Observation;
  readonly returns?: readonly RangeReturn[];
  readonly imu?: ImuReading;
}

function capture(ctx: SenseContext, spec: SensorSpec): Capture {
  switch (spec.modality) {
    case "rgb":
      return { observation: rgbObservation(ctx, spec) };
    case "thermal":
      return { observation: thermalObservation(ctx, spec) };
    case "lidar":
      return lidarCapture(ctx, spec);
    case "ultrasound":
      return ultrasoundCapture(ctx, spec);
    case "imu":
      return imuCapture(ctx, spec);
  }
}

function summarizeRanges(returns: readonly RangeReturn[], tick: Tick, latency: number): RangeReadings {
  const sector = (test: (r: RangeReturn) => boolean): number | null => {
    const ranges = returns.filter(test).map(r => r.rangeM);
    return ranges.length > 0 ? Math.min(...ranges) : null;
  };
  const level = (r: RangeReturn) => r.elevationBodyRad >= -45 * RAD;
  return {
    captureTick: tick,
    arrivalTick: tick + latency,
    forwardM: sector(r => level(r) && Math.abs(r.azimuthBodyRad) <= 30 * RAD),
    leftM: sector(r => level(r) && r.azimuthBodyRad >= 60 * RAD && r.azimuthBodyRad <= 120 * RAD),
    rightM: sector(r => level(r) && r.azimuthBodyRad <= -60 * RAD && r.azimuthBodyRad >= -120 * RAD),
    downM: sector(r => !level(r)),
  };
}

function imuCapture(ctx: SenseContext, spec: SensorSpec): Capture {
  const noise = (stream: string, axis: number, sigma: number) => sigma * keyedGaussian(ctx.world.seed, `${spec.id}/${stream}`, ctx.tick, axis);
  const imu: ImuReading = {
    captureTick: ctx.tick,
    arrivalTick: ctx.tick + spec.latencyTicks,
    angularRateRadps: vec3(noise("gyro", 0, IMU_MODEL.gyroNoiseRadps), noise("gyro", 1, IMU_MODEL.gyroNoiseRadps), ctx.world.drone.yawRateRadps + noise("gyro", 2, IMU_MODEL.gyroNoiseRadps)),
    specificForceMps2: vec3(noise("accel", 0, IMU_MODEL.accelNoiseMps2), noise("accel", 1, IMU_MODEL.accelNoiseMps2), IMU_MODEL.gravityMps2 + noise("accel", 2, IMU_MODEL.accelNoiseMps2)),
  };
  return { observation: buildObservation(ctx, spec, { quality: 1, footprint: null, personSearch: null, detections: [] }), imu };
}
