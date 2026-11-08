/**
 * Motion-controller interface for the fly-reflex comparison (PRD §5, §8; architecture §3).
 *
 * A deployed controller sees only calibrated camera luminance, the mission goal relative to its own pose
 * estimate, its previous executed command and explicit quality/range-assistance inputs. It never receives
 * true obstacle distances, occupant positions or any other simulator truth. Its output is a MotionRequest;
 * the harness applies the aircraft's real limits afterwards, so the caps here are only sanity bounds.
 *
 * Implementations: the conventional optical-flow baseline ("flow_baseline"), the engineered readout
 * ("engineered_readout") and, later, the trained FlyVis readout through an adapter ("fly_readout").
 */
import type { MotionCommand, MotionRequest, MotionSource } from "../../contracts/actions.ts";
import type { SensorSpec } from "../../contracts/aircraft.ts";
import { SCOUT_S1 } from "../../contracts/aircraft.ts";
import type { Tick } from "../../contracts/clock.ts";

export interface CameraFrame {
  readonly frameId: string;
  readonly captureTick: Tick;
  readonly width: number;
  readonly height: number;
  /** Row-major calibrated luminance in [0, 1]: index = row * width + column, row 0 at the top of the image. */
  readonly luminance: Float32Array;
  readonly calibrationId: string;
}

/** Goal relative to the estimated pose. */
export interface GoalEstimate {
  /** Body frame: 0 = straight ahead, positive = to the left. */
  readonly bearingRad: number;
  readonly distanceM: number;
  /** Goal height minus estimated height; positive means climb. */
  readonly heightErrorM: number;
  /**
   * Body-frame bearing (same convention as bearingRad) to face once the goal is reached: what the forward
   * cameras should search while the aircraft holds there (a spray aim, a breach strike point, a track).
   * Absent or null: no preference, the aircraft keeps its heading on arrival.
   */
  readonly faceBearingRad?: number | null;
}

export interface ControllerQuality {
  /** Estimated fidelity of the camera frame, 0..1, from the sensor adapter (exposure, smoke, blur). */
  readonly frame: number;
  /** One-sigma horizontal uncertainty of the pose estimate the goal was computed from. */
  readonly poseSigmaM: number;
}

/** Explicit range assistance in body-frame directions; null where that direction has no valid return. */
export interface RangeAssist {
  readonly forwardM: number | null;
  readonly leftM: number | null;
  readonly rightM: number | null;
  readonly downM: number | null;
}

export interface ControllerInput {
  readonly tick: Tick;
  readonly frame: CameraFrame | null;
  readonly goal: GoalEstimate | null;
  /** Previous executed (post-harness) command, used as an efference copy. */
  readonly previous: MotionCommand;
  readonly quality: ControllerQuality;
  /** null when the condition runs without range assistance. */
  readonly ranges: RangeAssist | null;
}

export interface ControllerOutput {
  readonly request: MotionRequest;
  /** Finite, JSON-safe diagnostic values (cues, time to contact, confidences) for logs and the comparison. */
  readonly features: Readonly<Record<string, number>>;
  /** "<source>/<mode>", e.g. "flow_baseline/brake_looming". Never claims fly-model inference. */
  readonly label: string;
}

export interface MotionController {
  readonly id: string;
  readonly source: MotionSource;
  /** Clear all temporal state (previous frame, filters, obstacle memory). Call on every run reset. */
  reset(): void;
  step(input: ControllerInput): ControllerOutput;
}

/** Pinhole model of the controller camera; principal point at the image centre, square pixels. */
export interface CameraModel {
  readonly horizontalFovDeg: number;
  /** Positive pitch looks below the horizon (same convention as SensorSpec.mount.pitchRad). */
  readonly pitchRad: number;
}

export function cameraModelFromSensor(spec: SensorSpec): CameraModel {
  if (spec.horizontalFovDeg === null || !(spec.horizontalFovDeg > 0 && spec.horizontalFovDeg < 180)) {
    throw new RangeError(`Sensor ${spec.id} has no usable horizontal field of view`);
  }
  return Object.freeze({ horizontalFovDeg: spec.horizontalFovDeg, pitchRad: spec.mount.pitchRad });
}

function rgbFrontSpec(): SensorSpec {
  const spec = SCOUT_S1.sensors.find(sensor => sensor.id === "rgb-front");
  if (!spec) throw new Error("SCOUT_S1 has no rgb-front sensor");
  return spec;
}

/** The contract's forward RGB camera: 90° horizontal field of view, pitched 10° down. */
export const RGB_FRONT_CAMERA: CameraModel = cameraModelFromSensor(rgbFrontSpec());

/** Focal length in pixels for an image `width` pixels wide. */
export function focalLengthPx(camera: CameraModel, width: number): number {
  return width / 2 / Math.tan((camera.horizontalFovDeg * Math.PI) / 360);
}

/**
 * Controller-independent reflex cues: what the shared cue → command mapping consumes. The flow baseline
 * derives them geometrically from optical flow; the engineered readout derives them from motion features
 * with hand-set weights. Neither derivation is fly-model inference.
 */
export interface ReflexCues {
  /** Reliability of the visual cues this step, 0..1 (0 = no usable vision). */
  readonly visualConfidence: number;
  /** Lateral imbalance in [−1, 1]: positive = more outward image motion on the left (left side nearer). */
  readonly centering: number;
  /** Significance of `centering`, 0..1 (enough lateral motion on both sides to trust the ratio). */
  readonly centeringWeight: number;
  /** Frontal looming rate 1/τ in s⁻¹ (≥ 0); null when it could not be measured this step. */
  readonly loomingRateHz: number | null;
  /** Avoidance hint in [−1, 1] while looming: positive = turn left (frontal expansion stronger on the right). */
  readonly avoidTurn: number;
}

/** Controller-side sanity caps. The harness enforces the aircraft's real hard limits and envelope afterwards. */
export interface ReflexLimits {
  /** Cap on the horizontal speed |(vx, vy)| of every request. */
  readonly maxSpeedMps: number;
  readonly maxVerticalSpeedMps: number;
  readonly maxYawRateRadps: number;
}

export const DEFAULT_REFLEX_LIMITS: ReflexLimits = Object.freeze({ maxSpeedMps: 2, maxVerticalSpeedMps: 0.8, maxYawRateRadps: 1.5 });
