/**
 * Authored test fixtures for the evidence module. Not a scene export, not the Troy interior and not a real
 * floor plan. Observations built here are labelled `provenance: "fixture"` with `oracle_fixture` detections,
 * so nothing derived from them is detector evidence.
 *
 * House: x 0..10 m (east), y 0..8 m (north); the front faces south (y = 0) and the rear is north (y = 8).
 * Floor 0 spans z 0..2.6 m and floor 1 spans z 3..5.6 m. Both floors have a "Rear bedroom" so that floor
 * words matter when interpreting reports.
 */
import type { AircraftStatusEstimate, CallerReport, EstimatedPose, FloorPlanPrior, LandingSupport } from "../contracts/evidence.ts";
import { vec3 } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import { box } from "../contracts/geometry.ts";
import type { ReportId, RoomId } from "../contracts/ids.ts";
import { deepFreeze } from "../contracts/ids.ts";
import type { Detection, DetectionMethod, HazardKind, Observation, ObservationProvenance, OpeningState, SensorModality } from "../contracts/observation.ts";
import type { EvidenceConfig } from "./config.ts";
import { defaultEvidenceConfig } from "./config.ts";
import type { SnapshotInput } from "./store.ts";
import { EvidenceStore } from "./store.ts";

export const FIXTURE_RUN = "fixture-run";

const prior: FloorPlanPrior = {
  revision: 3,
  source: "Authored evidence-module test fixture (two-level house); not a scene export or a real floor plan",
  floors: [
    { index: 0, elevationM: 0, ceilingM: 2.6 },
    { index: 1, elevationM: 3, ceilingM: 5.6 },
  ],
  rooms: [
    { id: "f0-living", name: "Living room", floor: 0, polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], zMin: 0, zMax: 2.6 },
    { id: "f0-kitchen", name: "Kitchen", floor: 0, polygon: [[0, 4], [4, 4], [4, 8], [0, 8]], zMin: 0, zMax: 2.6 },
    { id: "f0-rear-bedroom", name: "Rear bedroom", floor: 0, polygon: [[4, 4], [6, 4], [6, 8], [4, 8]], zMin: 0, zMax: 2.6 },
    { id: "f0-hall", name: "Front hall", floor: 0, polygon: [[6, 0], [10, 0], [10, 8], [6, 8]], zMin: 0, zMax: 2.6 },
    { id: "f1-front-bedroom", name: "Front bedroom", floor: 1, polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], zMin: 3, zMax: 5.6 },
    { id: "f1-rear-bedroom", name: "Rear bedroom", floor: 1, polygon: [[0, 4], [6, 4], [6, 8], [0, 8]], zMin: 3, zMax: 5.6 },
    { id: "f1-landing", name: "Landing", floor: 1, polygon: [[6, 0], [10, 0], [10, 8], [6, 8]], zMin: 3, zMax: 5.6 },
  ],
  openings: [
    { id: "front-door", kind: "door", rooms: ["f0-hall", "exterior"], center: vec3(8, 0, 1.05), widthM: 0.9, heightM: 2.1, outwardNormal: vec3(0, -1, 0), priorState: "closed" },
    { id: "f1-rear-window", kind: "window", rooms: ["f1-rear-bedroom", "exterior"], center: vec3(3, 8, 4.2), widthM: 1.2, heightM: 1.2, outwardNormal: vec3(0, 1, 0), priorState: "closed" },
    { id: "f1-rear-bedroom-door", kind: "door", rooms: ["f1-rear-bedroom", "f1-landing"], center: vec3(6, 6, 4.03), widthM: 0.8, heightM: 2.05, outwardNormal: vec3(1, 0, 0), priorState: "unknown" },
    { id: "f0-living-opening", kind: "opening", rooms: ["f0-living", "f0-hall"], center: vec3(6, 2, 1.05), widthM: 1.2, heightM: 2.1, outwardNormal: vec3(1, 0, 0), priorState: "open" },
  ],
  exits: [{ id: "exit-front", openingId: "front-door" }],
  assemblyPoint: box(vec3(6, -12, 0), vec3(10, -8, 2)),
};

export const FIXTURE_PRIOR: FloorPlanPrior = deepFreeze(prior);

export function fixtureConfig(overrides: Partial<Omit<EvidenceConfig, "runId" | "mapPrior">> = {}): EvidenceConfig {
  return { ...defaultEvidenceConfig(FIXTURE_RUN, FIXTURE_PRIOR), ...overrides };
}

export function fixtureStore(overrides: Partial<Omit<EvidenceConfig, "runId" | "mapPrior">> = {}): EvidenceStore {
  return new EvidenceStore(fixtureConfig(overrides));
}

export interface ObservationSpec {
  readonly id: string;
  readonly captureTick: number;
  /** Defaults to captureTick + 5 (the thermal camera's latency). */
  readonly arrivalTick?: number;
  readonly runId?: string;
  readonly modality?: SensorModality;
  readonly quality?: number;
  readonly footprint?: Region | null;
  readonly detections?: Detection[];
  /** Defaults to the method of the frame's person detections, else "oracle_fixture" for thermal frames, else null. */
  readonly personSearch?: DetectionMethod | null;
  /** Defaults to "<modality>-front". */
  readonly sensorId?: string;
  /** Defaults to "frame-<id>". */
  readonly frameId?: string | null;
  readonly provenance?: ObservationProvenance;
  readonly supersedes?: string | null;
}

export function observation(spec: ObservationSpec): Observation {
  return {
    id: spec.id,
    runId: spec.runId ?? FIXTURE_RUN,
    sensorId: spec.sensorId ?? `${spec.modality ?? "thermal"}-front`,
    modality: spec.modality ?? "thermal",
    captureTick: spec.captureTick,
    arrivalTick: spec.arrivalTick ?? spec.captureTick + 5,
    frameId: spec.frameId === undefined ? `frame-${spec.id}` : spec.frameId,
    calibrationId: "fixture-calibration-1",
    provenance: spec.provenance ?? "fixture",
    sensorPose: { position: vec3(3, 2, 4.2), yawRad: Math.PI / 2, sigmaM: 0.1 },
    quality: spec.quality ?? 0.8,
    footprint: spec.footprint ?? null,
    personSearch: spec.personSearch === undefined ? defaultPersonSearch(spec) : spec.personSearch,
    detections: spec.detections ?? [],
    supersedes: spec.supersedes ?? null,
  };
}

function defaultPersonSearch(spec: ObservationSpec): DetectionMethod | null {
  const detection = (spec.detections ?? []).find(d => d.kind === "possible_person");
  if (detection?.kind === "possible_person") return detection.method;
  return (spec.modality ?? "thermal") === "thermal" ? "oracle_fixture" : null;
}

export function person(x: number, y: number, z: number, options: { uncertaintyM?: number; confidence?: number } = {}): Detection {
  return { kind: "possible_person", position: vec3(x, y, z), uncertaintyM: options.uncertaintyM ?? 0.3, confidence: options.confidence ?? 0.6, method: "oracle_fixture" };
}

export function openingState(openingId: string, state: OpeningState): Detection {
  return { kind: "opening_state", openingId, state };
}

export function hazard(kind: HazardKind, region: Region, intensity: number): Detection {
  return { kind: "hazard", hazard: kind, region, intensity };
}

export interface ReportSpec {
  readonly id: ReportId;
  readonly receivedTick: number;
  readonly text: string;
  readonly runId?: string;
  readonly roomHint?: RoomId | null;
  readonly countText?: string | null;
  readonly supersedes?: ReportId | null;
}

export function report(spec: ReportSpec): CallerReport {
  return {
    id: spec.id,
    runId: spec.runId ?? FIXTURE_RUN,
    receivedTick: spec.receivedTick,
    source: "caller",
    channel: "typed",
    originalText: spec.text,
    roomHint: spec.roomHint ?? null,
    countText: spec.countText ?? null,
    interpretation: "rules",
    supersedes: spec.supersedes ?? null,
  };
}

export function snapshotInput(tick: number): SnapshotInput {
  const pose: EstimatedPose = { tick, position: vec3(3, 2, 4.2), yawRad: Math.PI / 2, velocity: vec3(0, 0, 0), sigmaM: 0.15, yawSigmaRad: 0.05, supported: true };
  const aircraft: AircraftStatusEstimate = { enduranceRemainingS: 600, waterRemainingL: 1, payloadsOnboard: [], ambientC: 31, thrustAvailableN: 60 };
  const landing: LandingSupport = { supported: false, site: null, evidenceIds: [], reason: "No downward ultrasound return yet." };
  return { tick, pose, aircraft, landing };
}
