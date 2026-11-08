import type { Tick } from "../contracts/clock.ts";
import type { FloorPlanPrior } from "../contracts/evidence.ts";
import type { RunId } from "../contracts/ids.ts";
import { deepFreeze } from "../contracts/ids.ts";
import { validate } from "../contracts/schema.ts";
import { configSchema, priorProblems } from "./schemas.ts";

export interface EvidenceConfig {
  readonly runId: RunId;
  /** The supplied floor plan. A prior with source and revision, not guaranteed current geometry. */
  readonly mapPrior: FloorPlanPrior;
  /**
   * Whole-frame observation quality (0..1] at or above which a frame's footprint counts as an adequate look
   * (and, on a person-search frame, refreshes the points it searched). Matches the harness's
   * minCoverageQuality: it rejects only frames unusable as a whole, because where a person would have been
   * detected is the footprint's job (person-search footprints are cut per point to PERSON_DETECTION_CONFIDENCE).
   */
  readonly adequateQuality: number;
  /** Grid spacing of each room's coverage sample points, in metres. */
  readonly coverageSpacingM: number;
  /** A snapshot carries observations with captureTick >= tick - observationWindowTicks. */
  readonly observationWindowTicks: Tick;
  /** Upper bound on the association gate, in metres. */
  readonly associationGateMaxM: number;
  /** How fast a possible occupant may move between sightings, in m/s. Widens the gate over time. */
  readonly occupantSpeedMps: number;
  /** possible_person detections below this confidence neither create nor update tracks. */
  readonly minTrackConfidence: number;
}

/** Default thresholds: adequate quality 0.3, 0.5 m coverage grid, 30 s window, 3 m gate cap, 1.2 m/s, confidence 0.2. */
export const EVIDENCE_DEFAULTS: Omit<EvidenceConfig, "runId" | "mapPrior"> = deepFreeze({
  adequateQuality: 0.3,
  coverageSpacingM: 0.5,
  observationWindowTicks: 3000,
  associationGateMaxM: 3,
  occupantSpeedMps: 1.2,
  minTrackConfidence: 0.2,
});

export function defaultEvidenceConfig(runId: RunId, mapPrior: FloorPlanPrior): EvidenceConfig {
  return { runId, mapPrior, ...EVIDENCE_DEFAULTS };
}

/** Every reason the configuration cannot be used; empty when it is valid. */
export function configProblems(config: EvidenceConfig): string[] {
  const errors = validate(configSchema, config);
  return errors.length > 0 ? errors : priorProblems(config.mapPrior);
}
