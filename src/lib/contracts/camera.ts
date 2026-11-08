/**
 * Calibrated drone camera: fixed, versioned intrinsics and extrinsics.
 *
 * The neural and optical-flow controllers receive luminance frames from this calibration only; render
 * quality settings change presentation, never the benchmark camera. Smoke and occlusion are rendered into
 * these frames by the same field the simulator uses.
 */
import type { SensorSpec } from "./aircraft.ts";
import type { Tick } from "./clock.ts";
import type { Vec3 } from "./frames.ts";
import { bodyToOptical, sub } from "./frames.ts";

export interface CameraCalibration {
  /** e.g. "rgb-front/v1"; changes whenever any field changes. */
  readonly id: string;
  readonly sensorId: string;
  readonly width: number;
  readonly height: number;
  /** Pinhole intrinsics in pixels; pixel centres are at integer coordinates. */
  readonly fx: number;
  readonly fy: number;
  readonly cx: number;
  readonly cy: number;
  /** Extrinsics in the body frame; positive pitch looks below the horizon. */
  readonly mount: { readonly positionBody: Vec3; readonly yawRad: number; readonly pitchRad: number };
  /** Linear-light luminance → frame value: clamp((gain · L) ^ (1 / gamma), 0, 1). */
  readonly exposure: { readonly gain: number; readonly gamma: number };
  /** Additive read noise (frame units) keyed to this stream by the sensor model. */
  readonly noise: { readonly readSigma: number; readonly stream: string };
}

/** One luminance frame, row-major from the top-left pixel, values in [0, 1]. */
export interface CameraFrame {
  readonly frameId: string;
  readonly captureTick: Tick;
  readonly calibrationId: string;
  readonly width: number;
  readonly height: number;
  readonly luminance: Float32Array;
}

/** Rec. 709 relative-luminance weights for linear RGB. */
export const LUMINANCE_WEIGHTS = Object.freeze({ r: 0.2126, g: 0.7152, b: 0.0722 });

/** Build a calibration from a camera SensorSpec using square pixels and the horizontal field of view. */
export function calibrationFromSensor(spec: SensorSpec, version: number): CameraCalibration {
  if (spec.resolution === null || spec.horizontalFovDeg === null) throw new RangeError(`${spec.id} is not an imaging sensor`);
  const { width, height } = spec.resolution;
  const fx = width / 2 / Math.tan((spec.horizontalFovDeg * Math.PI) / 360);
  return {
    id: `${spec.id}/v${version}`,
    sensorId: spec.id,
    width,
    height,
    fx,
    fy: fx,
    cx: (width - 1) / 2,
    cy: (height - 1) / 2,
    mount: spec.mount,
    exposure: { gain: 1, gamma: 2.2 },
    noise: { readSigma: 0.01, stream: `${spec.id}/read-noise` },
  };
}

/** Vertical field of view implied by square pixels. */
export function verticalFovDeg(calibration: CameraCalibration): number {
  return (2 * Math.atan(calibration.height / 2 / calibration.fy) * 180) / Math.PI;
}

/**
 * Project a body-frame point to pixel coordinates. Returns null for points behind the lens.
 * The mount yaw is applied about body Z before the pitch.
 */
export function projectBodyPoint(calibration: CameraCalibration, pointBody: Vec3): { readonly u: number; readonly v: number; readonly depth: number } | null {
  const relative = sub(pointBody, calibration.mount.positionBody);
  const c = Math.cos(-calibration.mount.yawRad);
  const s = Math.sin(-calibration.mount.yawRad);
  const unyawed = { x: c * relative.x - s * relative.y, y: s * relative.x + c * relative.y, z: relative.z };
  const optical = bodyToOptical(unyawed, calibration.mount.pitchRad);
  if (optical.z <= 1e-9) return null;
  return { u: calibration.cx + (calibration.fx * optical.x) / optical.z, v: calibration.cy + (calibration.fy * optical.y) / optical.z, depth: optical.z };
}
