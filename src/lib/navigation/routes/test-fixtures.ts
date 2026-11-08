/**
 * Route-assessor test fixtures: a small fictional two-floor house and belief builders. Every observation is
 * an authored fixture (provenance "fixture", person search "oracle_fixture"), not simulator output.
 *
 * Layout (world frame, metres, Z up). Ground floor z 0–2.8: hall-g x 0–6 and kitchen x 6.1–10, both y 0–4.
 * Upper floor z 3.0–5.8: hall-u x 0–6 and bedroom x 6.1–10. Walls are the 0.1 m gaps. A straight stair
 * rises along y = 1 from (1, 1, 0) in hall-g to (5, 1, 3) in hall-u. The front door (the only exit) is in
 * hall-g's west wall, the back door in the kitchen's east wall and the bedroom window in its east wall.
 * The assembly point is west of the house; the launch point east of it.
 */
import type { Tick } from "../../contracts/clock.ts";
import type { BeliefSnapshot, FloorPlanPrior, HazardEvidence, OpeningEvidence, RoomCoverage } from "../../contracts/evidence.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { vec3 } from "../../contracts/frames.ts";
import type { Region } from "../../contracts/geometry.ts";
import { box, sphere } from "../../contracts/geometry.ts";
import type { Observation, OpeningState } from "../../contracts/observation.ts";
import { DEFAULT_POLICY } from "../../harness/policy.ts";
import type { RouteAssessorInput, RouteRequest } from "./index.ts";

export const RUN = "run-routes";
export const NOW: Tick = 10_000;
export const ROOM_IDS = ["hall-g", "kitchen", "hall-u", "bedroom"] as const;

const ROOM_BOXES: Record<(typeof ROOM_IDS)[number], Region> = {
  "hall-g": box(vec3(0, 0, 0), vec3(6, 4, 2.8)),
  kitchen: box(vec3(6.1, 0, 0), vec3(10, 4, 2.8)),
  "hall-u": box(vec3(0, 0, 3), vec3(6, 4, 5.8)),
  bedroom: box(vec3(6.1, 0, 3), vec3(10, 4, 5.8)),
};

export const PRIOR: FloorPlanPrior = {
  revision: 1,
  source: "fixture: authored fictional two-floor house",
  floors: [{ index: 0, elevationM: 0, ceilingM: 2.8 }, { index: 1, elevationM: 3, ceilingM: 5.8 }],
  rooms: [
    { id: "hall-g", name: "Ground hall", floor: 0, polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], zMin: 0, zMax: 2.8 },
    { id: "kitchen", name: "Kitchen", floor: 0, polygon: [[6.1, 0], [10, 0], [10, 4], [6.1, 4]], zMin: 0, zMax: 2.8 },
    { id: "hall-u", name: "Upper hall", floor: 1, polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], zMin: 3, zMax: 5.8 },
    { id: "bedroom", name: "Bedroom", floor: 1, polygon: [[6.1, 0], [10, 0], [10, 4], [6.1, 4]], zMin: 3, zMax: 5.8 },
  ],
  openings: [
    { id: "front-door", kind: "door", rooms: ["hall-g", "exterior"], center: vec3(-0.05, 2, 1.1), widthM: 1, heightM: 2.2, outwardNormal: vec3(-1, 0, 0), priorState: "closed" },
    { id: "back-door", kind: "door", rooms: ["kitchen", "exterior"], center: vec3(10.05, 2, 1.1), widthM: 1, heightM: 2.2, outwardNormal: vec3(1, 0, 0), priorState: "closed" },
    { id: "door-g", kind: "door", rooms: ["hall-g", "kitchen"], center: vec3(6.05, 2, 1.1), widthM: 0.9, heightM: 2.1, outwardNormal: vec3(1, 0, 0), priorState: "open" },
    { id: "door-u", kind: "door", rooms: ["hall-u", "bedroom"], center: vec3(6.05, 2, 4.1), widthM: 0.9, heightM: 2.1, outwardNormal: vec3(1, 0, 0), priorState: "open" },
    { id: "window-bedroom", kind: "window", rooms: ["bedroom", "exterior"], center: vec3(10.05, 2, 4.5), widthM: 1.1, heightM: 1.3, outwardNormal: vec3(1, 0, 0), priorState: "closed" },
  ],
  exits: [{ id: "exit-front", openingId: "front-door" }],
  assemblyPoint: box(vec3(-12, 0, 0), vec3(-8, 4, 2.5)),
  stairs: [{ id: "stair", bottomRoomId: "hall-g", topRoomId: "hall-u", bottom: vec3(1, 1, 0), top: vec3(5, 1, 3), widthM: 1 }],
};

export const ASSEMBLY_CENTRE = vec3(-10, 2, 1.25);
export const LAUNCH = vec3(14, 2, 0.5);
export const OCCUPANT_AT = vec3(8, 2, 3.05);
export const DRONE_IN_BEDROOM = vec3(8, 2.5, 4.3);
/** Where the upstairs hall meets the stair: on the evacuation corridor. */
export const STAIR_TOP_FIRE = vec3(5.2, 1.4, 3.2);

export function evacuation(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return { id: "route-evacuation", purpose: "evacuation", from: OCCUPANT_AT, destination: { kind: "exit", exitId: "exit-front", then: ASSEMBLY_CENTRE }, traveler: "occupant", speedMps: 0.8, ...overrides };
}

export function droneReturn(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return { id: "route-return", purpose: "return", from: DRONE_IN_BEDROOM, destination: { kind: "point", point: LAUNCH }, traveler: "drone", speedMps: 1, ...overrides };
}

export function view(id: string, captureTick: Tick, footprint: Region | null, overrides: Partial<Observation> = {}): Observation {
  return {
    id, runId: RUN, sensorId: "rgb-front", modality: "rgb", captureTick, arrivalTick: captureTick, frameId: null, calibrationId: null,
    provenance: "fixture", sensorPose: { position: vec3(0, 0, 0), yawRad: 0, sigmaM: 0.1 }, quality: 0.9, footprint,
    personSearch: "oracle_fixture", detections: [], supersedes: null, ...overrides,
  };
}

/** One person-search view per room at `tick` (id "view-<room>-<tick>") and coverage entries with 90% of each room searched then. */
export function roomsSeenAt(tick: Tick, rooms: readonly (typeof ROOM_IDS)[number][] = ROOM_IDS): { observations: Observation[]; coverage: RoomCoverage[] } {
  return {
    observations: rooms.map(room => view(`view-${room}-${tick}`, tick, ROOM_BOXES[room])),
    coverage: rooms.map(room => ({ roomId: room, state: "observed", fractionAdequate: 0.9, fractionAny: 1, lastObservedTick: tick, bestModality: "rgb", fractionSearched: 0.9, searchedSince: [{ sinceTick: tick, fraction: 0.9 }] })),
  };
}

export function openingSeen(openingId: string, state: OpeningState, tick: Tick): { observation: Observation; evidence: OpeningEvidence } {
  const observationId = `opening-${openingId}-${state}-${tick}`;
  return {
    observation: view(observationId, tick, null, { detections: [{ kind: "opening_state", openingId, state }] }),
    evidence: { openingId, state, tick, observationId },
  };
}

/** A thermal frame sighting fire at `center`; intensity 0 is a sighting of the place with no flame (a fire that is out). */
export function fireSeen(id: string, tick: Tick, center: Vec3 = STAIR_TOP_FIRE, radiusM = 0.3, intensity = 0.8, overrides: Partial<Observation> = {}): { observation: Observation; hazard: HazardEvidence } {
  const region = sphere(center, radiusM);
  return {
    observation: view(id, tick, sphere(center, 2), { modality: "thermal", sensorId: "thermal-front", detections: [{ kind: "hazard", hazard: "fire", region, intensity }], ...overrides }),
    hazard: { observationId: id, tick, hazard: "fire", region, intensity },
  };
}

export interface Scene {
  readonly observations?: readonly Observation[];
  readonly coverage?: readonly RoomCoverage[];
  readonly openings?: readonly { observation: Observation; evidence: OpeningEvidence }[];
  readonly fires?: readonly { observation: Observation; hazard: HazardEvidence }[];
  readonly prior?: FloorPlanPrior;
}

export function input(scene: Scene, lastInterventionTick: Tick | null = null, tick: Tick = NOW): RouteAssessorInput {
  const openings = scene.openings ?? [];
  const fires = scene.fires ?? [];
  const belief: BeliefSnapshot = {
    runId: RUN, tick, evidenceRevision: 1, mapPrior: scene.prior ?? PRIOR, mapRevision: 1, mapChanges: [],
    pose: { tick, position: DRONE_IN_BEDROOM, yawRad: 0, velocity: vec3(0, 0, 0), sigmaM: 0.1, yawSigmaRad: 0.02, supported: true },
    aircraft: { enduranceRemainingS: 600, waterRemainingL: 1, payloadsOnboard: [], ambientC: 25, thrustAvailableN: 60 },
    landing: { supported: false, site: null, evidenceIds: [], reason: "fixture" },
    observations: [...(scene.observations ?? []), ...openings.map(o => o.observation), ...fires.map(f => f.observation)],
    reports: [], tracks: [], crewConfirmations: [],
    coverage: scene.coverage ?? [],
    hazards: fires.map(f => f.hazard),
    openings: openings.map(o => o.evidence),
    routes: [], dispatchConfirmed: null,
  };
  // The fixtures were written against a 30 s route evidence age; they test the mechanism, not the default value.
  return { belief, tick, lastInterventionTick, policy: { ...DEFAULT_POLICY, routeEvidenceMaxAgeTicks: 3000 } };
}

/** Every opening observed in its usual state (front and back doors closed, interior doors open, window broken). */
export function allOpeningsSeen(tick: Tick, overrides: Partial<Record<string, OpeningState>> = {}): { observation: Observation; evidence: OpeningEvidence }[] {
  const states: Record<string, OpeningState> = { "front-door": "closed", "back-door": "closed", "door-g": "open", "door-u": "open", "window-bedroom": "broken" };
  return Object.entries({ ...states, ...overrides }).map(([id, state]) => openingSeen(id, state as OpeningState, tick));
}
