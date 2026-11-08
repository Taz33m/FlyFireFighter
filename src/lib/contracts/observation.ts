/**
 * Observations: what a sensor adapter derived from one sensor frame.
 *
 * Every observation records what it covered (footprint at its estimated quality) and what it detected.
 * Quality is estimated from the measurement itself (contrast, return rate, saturation), never from hidden
 * simulator truth. A footprint without a detection is coverage, not proof of absence; whether coverage is
 * adequate is decided by the harness against explicit thresholds.
 */
import type { Tick } from "./clock.ts";
import type { Vec3 } from "./frames.ts";
import type { Region } from "./geometry.ts";
import type { ObservationId, OpeningId, RunId } from "./ids.ts";

export type SensorModality = "rgb" | "thermal" | "lidar" | "ultrasound" | "imu";

/** simulated_sensor: produced by the twin's sensor model; fixture: authored test input; recording: replayed. */
export type ObservationProvenance = "simulated_sensor" | "fixture" | "recording";

/**
 * oracle_fixture: a raycast against the hidden person — a labelled fixture, not detector accuracy.
 * thermal_blob / image_detector: an actual detector run on rendered sensor data.
 */
export type DetectionMethod = "oracle_fixture" | "thermal_blob" | "image_detector";

/**
 * Confidence at or above which a possible-person detection counts as a person: the harness's default
 * personConfidenceThreshold. A person-search footprint is cut to it (Observation.footprint), so the two
 * cannot drift apart.
 */
export const PERSON_DETECTION_CONFIDENCE = 0.2;

export type OpeningState = "closed" | "open" | "broken" | "blocked";

export type HazardKind = "fire" | "smoke" | "heat" | "obstruction";

export type Detection =
  | {
      readonly kind: "possible_person";
      readonly position: Vec3;
      /** One-sigma radius in the world frame, already including the sensor's pose uncertainty. */
      readonly uncertaintyM: number;
      readonly confidence: number;
      readonly method: DetectionMethod;
    }
  | { readonly kind: "hazard"; readonly hazard: HazardKind; readonly region: Region; readonly intensity: number }
  | { readonly kind: "opening_state"; readonly openingId: OpeningId; readonly state: OpeningState };

/** Sensor pose at capture, from the aircraft's own localization estimate (never ground truth). */
export interface SensorPoseEstimate {
  readonly position: Vec3;
  readonly yawRad: number;
  readonly sigmaM: number;
}

export interface Observation {
  readonly id: ObservationId;
  readonly runId: RunId;
  readonly sensorId: string;
  readonly modality: SensorModality;
  readonly captureTick: Tick;
  /** When the observation became available to the belief; arrivalTick >= captureTick. */
  readonly arrivalTick: Tick;
  readonly frameId: string | null;
  readonly calibrationId: string | null;
  readonly provenance: ObservationProvenance;
  readonly sensorPose: SensorPoseEstimate;
  /** Estimated fidelity of this frame for detection, 0..1: a whole-frame figure. */
  readonly quality: number;
  /**
   * Volume this frame observed; null for non-spatial sensors such as the IMU. On a frame searched for people
   * (personSearch not null) it holds only points where a person in view would have been reported at
   * confidence ≥ PERSON_DETECTION_CONFIDENCE: smoke, range, glass and heat are already accounted for per
   * point, so a smoky frame's clear near field still counts while its obscured far field does not.
   */
  readonly footprint: Region | null;
  /**
   * The person-detection method actually applied to this frame, or null when none ran. Only frames that
   * were searched for people can cover an intervention region or clear an earlier possible-person
   * detection: a frame with no person detector says nothing about absence. Every possible_person
   * detection in the frame uses this method.
   */
  readonly personSearch: DetectionMethod | null;
  readonly detections: readonly Detection[];
  /**
   * An earlier observation from the same sensor that this one replaces (e.g. a re-processed frame). The
   * replaced observation can no longer support an action; it stays in the record.
   */
  readonly supersedes: ObservationId | null;
}
