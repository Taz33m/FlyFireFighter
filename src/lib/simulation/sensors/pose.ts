/**
 * Sensor mounting geometry. Physical measurements are traced from the TRUE pose (the sensor really is
 * there); everything an observation reports is expressed from the ESTIMATED pose (estimatedPose), so
 * localization error shifts footprints and detections exactly as it would for a real aircraft.
 */
import type { SensorSpec } from "../../contracts/aircraft.ts";
import type { Pose, Vec3 } from "../../contracts/frames.ts";
import { bodyPointToWorld, rotateBodyToWorld, rotateWorldToBody, sub, vec3 } from "../../contracts/frames.ts";
import type { WorldState } from "../world-state.ts";

export function truePose(world: WorldState): Pose {
  return { position: world.drone.position, yawRad: world.drone.yawRad };
}

export function sensorOrigin(pose: Pose, spec: SensorSpec): Vec3 {
  return bodyPointToWorld(pose, spec.mount.positionBody);
}

/**
 * World direction of a ray at (azimuth, elevation) about the sensor's optical axis: azimuth positive to the
 * left, elevation positive up. The mount pitch (positive looks down) is applied, then mount and body yaw.
 */
export function sensorDirection(pose: Pose, spec: SensorSpec, azimuthRad: number, elevationRad: number): Vec3 {
  const ce = Math.cos(elevationRad);
  const sx = ce * Math.cos(azimuthRad);
  const sy = ce * Math.sin(azimuthRad);
  const sz = Math.sin(elevationRad);
  const c = Math.cos(spec.mount.pitchRad);
  const s = Math.sin(spec.mount.pitchRad);
  return rotateBodyToWorld(pose.yawRad + spec.mount.yawRad, vec3(sx * c + sz * s, sy, -sx * s + sz * c));
}

/** Inverse of sensorDirection for a world point: angles about the optical axis and range from the sensor. */
export function sensorAngles(pose: Pose, spec: SensorSpec, point: Vec3): { readonly azimuthRad: number; readonly elevationRad: number; readonly rangeM: number } {
  const relative = rotateWorldToBody(pose.yawRad + spec.mount.yawRad, sub(point, sensorOrigin(pose, spec)));
  const c = Math.cos(spec.mount.pitchRad);
  const s = Math.sin(spec.mount.pitchRad);
  const forward = c * relative.x - s * relative.z;
  const up = s * relative.x + c * relative.z;
  const rangeM = Math.hypot(relative.x, relative.y, relative.z);
  return { azimuthRad: Math.atan2(relative.y, forward), elevationRad: Math.atan2(up, Math.hypot(forward, relative.y)), rangeM };
}

/** Pinhole camera frame: optical axis (forward), image up and image left (up × forward), all unit vectors. */
export interface CameraFrame {
  readonly origin: Vec3;
  readonly forward: Vec3;
  readonly up: Vec3;
  readonly left: Vec3;
}

export function cameraFrame(pose: Pose, spec: SensorSpec): CameraFrame {
  const forward = sensorDirection(pose, spec, 0, 0);
  const up = sensorDirection(pose, spec, 0, Math.PI / 2);
  const left = vec3(up.y * forward.z - up.z * forward.y, up.z * forward.x - up.x * forward.z, up.x * forward.y - up.y * forward.x);
  return { origin: sensorOrigin(pose, spec), forward, up, left };
}

/**
 * True when a world point is inside the camera's pinhole frustum (|left / forward| ≤ tan(hfov / 2) and
 * |up / forward| ≤ tan(vfov / 2), as in the rendered image and the depth-image footprint) within reachM.
 */
export function inPinholeView(pose: Pose, spec: SensorSpec, point: Vec3, reachM: number): boolean {
  const frame = cameraFrame(pose, spec);
  const q = sub(point, frame.origin);
  const f = q.x * frame.forward.x + q.y * frame.forward.y + q.z * frame.forward.z;
  if (!(f > 0) || Math.hypot(q.x, q.y, q.z) > reachM) return false;
  const x = (q.x * frame.left.x + q.y * frame.left.y + q.z * frame.left.z) / f;
  const y = (q.x * frame.up.x + q.y * frame.up.y + q.z * frame.up.z) / f;
  return Math.abs(x) <= Math.tan(((spec.horizontalFovDeg ?? 0) * Math.PI) / 360) && Math.abs(y) <= Math.tan(((spec.verticalFovDeg ?? 0) * Math.PI) / 360);
}

/** Re-express a world point measured from the true pose in the frame of the estimated pose. */
export function toEstimatedFrame(truth: Pose, estimate: Pose, point: Vec3): Vec3 {
  return bodyPointToWorld(estimate, rotateWorldToBody(truth.yawRad, sub(point, truth.position)));
}
