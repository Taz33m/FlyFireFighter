/**
 * Pure drone-camera math shared by the WebGL capture path and its tests (no Three.js, no WebGL).
 *
 * Conventions (see contracts/frames.ts and contracts/camera.ts):
 * - Pixel coordinates follow the calibration: u to the right, v down, pixel centres at integers, so the
 *   image spans u ∈ [-0.5, W - 0.5] and v ∈ [-0.5, H - 0.5].
 * - A Three.js camera looks along its local -Z with +Y up and +X right. Its basis in the render frame
 *   (Y up) is built from the true aircraft pose and the calibrated mount (yaw about body Z, then pitch;
 *   positive pitch looks below the horizon).
 * - WebGL framebuffer rows start at the BOTTOM. The camera_frame protocol wants row 0 at the TOP, so every
 *   readback is flipped: output row v = framebuffer row (H - 1 - v).
 *
 * Colour management of the capture (documented here because the frame values depend on it):
 * - The capture target is a linear float render target. Three.js r186 renders non-XR render targets in
 *   the linear-sRGB working colour space with tone mapping disabled, so readback values are linear RGB.
 * - Luminance uses Rec. 709 weights on that linear RGB, then the calibration exposure:
 *   frame = clamp((gain · L) ^ (1 / gamma), 0, 1). No noise is added here; the worker's sensor model
 *   owns read noise.
 */
import { AIRCRAFT_PROFILES } from "../contracts/aircraft.ts";
import type { CameraCalibration } from "../contracts/camera.ts";
import { LUMINANCE_WEIGHTS, calibrationFromSensor } from "../contracts/camera.ts";
import type { Pose, Vec3 } from "../contracts/frames.ts";
import { bodyPointToWorld, rotateBodyToWorld, vec3, worldToRender } from "../contracts/frames.ts";

/** Near and far clip planes for the sensor camera, in metres. */
export const SENSOR_NEAR_M = 0.05;
export const SENSOR_FAR_M = 150;

export const CAMERA_SENSOR_ID = "rgb-front";
export const CAMERA_CALIBRATION_VERSION = 1;

/** The locked controller camera for an aircraft profile: calibrationFromSensor(rgb-front, v1). */
export function lockedCalibration(aircraftId: string): CameraCalibration {
  const profile = AIRCRAFT_PROFILES.find(p => p.id === aircraftId);
  if (profile === undefined) throw new RangeError(`Unknown aircraft profile ${aircraftId}`);
  const spec = profile.sensors.find(s => s.id === CAMERA_SENSOR_ID);
  if (spec === undefined) throw new RangeError(`${aircraftId} has no ${CAMERA_SENSOR_ID} camera`);
  return calibrationFromSensor(spec, CAMERA_CALIBRATION_VERSION);
}

/**
 * OpenGL-style projection matrix from pinhole intrinsics, column-major (the order of Three.js
 * Matrix4.elements). Maps camera-space points (looking down -Z) to clip space so that NDC x = -1 is the
 * left image edge (u = -0.5) and NDC y = +1 is the top edge (v = -0.5).
 */
export function projectionFromIntrinsics(calibration: CameraCalibration, near = SENSOR_NEAR_M, far = SENSOR_FAR_M): number[] {
  const { width: w, height: h, fx, fy, cx, cy } = calibration;
  if (!(near > 0 && far > near)) throw new RangeError("Projection needs 0 < near < far");
  const a = (2 * fx) / w;
  const b = (2 * fy) / h;
  // Off-axis terms vanish for a centred principal point (cx = (w - 1) / 2, cy = (h - 1) / 2).
  const c = 1 - (2 * (cx + 0.5)) / w;
  const d = (2 * (cy + 0.5)) / h - 1;
  const e = -(far + near) / (far - near);
  const f = (-2 * far * near) / (far - near);
  // Row-major [a 0 c 0; 0 b d 0; 0 0 e f; 0 0 -1 0] written column by column.
  return [a, 0, 0, 0, 0, b, 0, 0, c, d, e, -1, 0, 0, f, 0];
}

/** Camera position and orthonormal basis in the RENDER frame (Three.js camera local X, Y, Z axes). */
export interface RenderCameraPose {
  readonly position: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  /** Local +Z of the Three.js camera: the opposite of the lens axis. */
  readonly back: Vec3;
}

function rotateZ(v: Vec3, yawRad: number): Vec3 {
  return rotateBodyToWorld(yawRad, v);
}

/** Where the calibrated camera is and how it is oriented when the aircraft is truly at `pose`. */
export function renderCameraPose(calibration: CameraCalibration, pose: Pose): RenderCameraPose {
  const { positionBody, yawRad: mountYaw, pitchRad } = calibration.mount;
  const c = Math.cos(pitchRad);
  const s = Math.sin(pitchRad);
  // Camera axes in the body frame: mount yaw about body Z, then pitch down.
  const forwardBody = rotateZ(vec3(c, 0, -s), mountYaw);
  const rightBody = rotateZ(vec3(0, -1, 0), mountYaw);
  const upBody = rotateZ(vec3(s, 0, c), mountYaw);
  const toRender = (v: Vec3) => worldToRender(rotateBodyToWorld(pose.yawRad, v));
  const forward = toRender(forwardBody);
  return {
    position: worldToRender(bodyPointToWorld(pose, positionBody)),
    right: toRender(rightBody),
    up: toRender(upBody),
    back: vec3(-forward.x, -forward.y, -forward.z),
  };
}

/** Rec. 709 relative luminance of linear RGB. */
export function relativeLuminance(r: number, g: number, b: number): number {
  return LUMINANCE_WEIGHTS.r * r + LUMINANCE_WEIGHTS.g * g + LUMINANCE_WEIGHTS.b * b;
}

/** Calibration exposure: clamp((gain · L) ^ (1 / gamma), 0, 1); NaN and negative light give 0. */
export function encodeLuminance(linear: number, exposure: CameraCalibration["exposure"]): number {
  const exposed = exposure.gain * linear;
  if (!(exposed > 0)) return 0;
  if (exposed >= 1) return 1;
  return Math.pow(exposed, 1 / exposure.gamma);
}

/**
 * Convert a bottom-up RGBA readback (float linear light, or 8-bit linear values scaled by 1/255) into a
 * top-down, display-encoded luminance frame. Alpha is ignored.
 */
export function luminanceFrameFromReadback(
  rgba: Float32Array | Uint8Array,
  width: number,
  height: number,
  exposure: CameraCalibration["exposure"],
  out: Float32Array = new Float32Array(width * height),
): Float32Array {
  if (rgba.length < width * height * 4) throw new RangeError("Readback buffer is smaller than width × height × 4");
  if (out.length !== width * height) throw new RangeError("Output frame must hold width × height values");
  const scale = rgba instanceof Uint8Array ? 1 / 255 : 1;
  for (let row = 0; row < height; row++) {
    const source = row * width * 4;
    const target = (height - 1 - row) * width;
    for (let col = 0; col < width; col++) {
      const i = source + col * 4;
      const linear = relativeLuminance(rgba[i] * scale, rgba[i + 1] * scale, rgba[i + 2] * scale);
      out[target + col] = encodeLuminance(linear, exposure);
    }
  }
  return out;
}
