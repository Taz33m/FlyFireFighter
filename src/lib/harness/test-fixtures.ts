/**
 * Deterministic harness test fixtures: a small fictional two-level house, the Tender T1 profile, the default
 * policy, a mission envelope and belief builders. Every observation here is an authored fixture
 * (provenance "fixture"; person search and detections use "oracle_fixture"); none of it is simulator output
 * or detector accuracy. Numbers are chosen so each standard scenario passes every rule; tests then change
 * one input.
 *
 * Layout (world frame, metres, Z up). The house is x 0–12, y 0–4. Upper floor, z 3.0–5.6: rear bedroom
 * x 0–3.94; hallway x 4.06–9.94, y 0–1.94; bathroom x 4.06–9.94, y 2.06–4; landing x 10.06–12. Ground floor,
 * z 0–2.8: living room x 0–5.94 and kitchen x 6.06–12. Interior walls are the 0.12 m gaps between rooms and
 * the slab is z 2.8–3.0. A small fire burns on the hallway floor near (7, 1, 3.3). The rear window is in
 * the bedroom's west wall at (0, 2, 4.2). The possible occupant is in the bedroom's far corner.
 */
import type { ActionSpec, ApproveCommand, ExecuteCommand, ProposalBasis, ProposalInput } from "../contracts/actions.ts";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import type { Tick } from "../contracts/clock.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import type {
  AircraftStatusEstimate,
  BeliefSnapshot,
  FloorPlanPrior,
  HazardEvidence,
  LandingSupport,
  MapChange,
  OccupantTrack,
  OpeningEvidence,
  RouteAssessment,
} from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { vec3 } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import { box, sphere, union } from "../contracts/geometry.ts";
import type { ObservationId, ProposalId, RunId } from "../contracts/ids.ts";
import type { Detection, DetectionMethod, Observation, OpeningState, SensorModality } from "../contracts/observation.ts";
import type { HarnessContext } from "./policy.ts";
import { DEFAULT_POLICY } from "./policy.ts";

export const RUN_ID: RunId = "run-1";
export const COMMANDER = "commander-1";
/** Tick at which the standard scenarios submit. */
export const T0: Tick = 1000;
/** The fire frame predates T0 − coverageFreshTicks, so it is citable evidence but never fresh coverage at T0. */
export const FIRE_SEEN_TICK: Tick = 700;

export const BASIS: ProposalBasis = { evidenceRevision: 10, mapRevision: 1, profileRevision: TENDER_T1.revision, envelopeRevision: 1, policyRevision: DEFAULT_POLICY.revision };

export const FLOOR_PLAN: FloorPlanPrior = {
  revision: 1,
  source: "fixture: authored fictional two-level house",
  floors: [{ index: 0, elevationM: 0, ceilingM: 2.8 }, { index: 1, elevationM: 3, ceilingM: 5.6 }],
  rooms: [
    { id: "living", name: "Living room", floor: 0, polygon: [[0, 0], [5.94, 0], [5.94, 4], [0, 4]], zMin: 0, zMax: 2.8 },
    { id: "kitchen", name: "Kitchen", floor: 0, polygon: [[6.06, 0], [12, 0], [12, 4], [6.06, 4]], zMin: 0, zMax: 2.8 },
    { id: "bedroom-rear", name: "Rear bedroom", floor: 1, polygon: [[0, 0], [3.94, 0], [3.94, 4], [0, 4]], zMin: 3, zMax: 5.6 },
    { id: "hallway", name: "Upstairs hallway", floor: 1, polygon: [[4.06, 0], [9.94, 0], [9.94, 1.94], [4.06, 1.94]], zMin: 3, zMax: 5.6 },
    { id: "bathroom", name: "Bathroom", floor: 1, polygon: [[4.06, 2.06], [9.94, 2.06], [9.94, 4], [4.06, 4]], zMin: 3, zMax: 5.6 },
    { id: "landing", name: "Stair landing", floor: 1, polygon: [[10.06, 0], [12, 0], [12, 4], [10.06, 4]], zMin: 3, zMax: 5.6 },
  ],
  openings: [
    { id: "window-rear", kind: "window", rooms: ["bedroom-rear", "exterior"], center: vec3(0, 2, 4.2), widthM: 1, heightM: 1.2, outwardNormal: vec3(-1, 0, 0), priorState: "closed" },
    { id: "door-bedroom", kind: "door", rooms: ["bedroom-rear", "hallway"], center: vec3(4, 1, 4), widthM: 0.9, heightM: 2, outwardNormal: vec3(1, 0, 0), priorState: "open" },
    { id: "door-front", kind: "door", rooms: ["kitchen", "exterior"], center: vec3(12, 2, 1), widthM: 0.9, heightM: 2, outwardNormal: vec3(1, 0, 0), priorState: "closed" },
  ],
  exits: [{ id: "exit-front", openingId: "door-front" }],
  assemblyPoint: box(vec3(16, -2, 0), vec3(20, 2, 2)),
};

/** An occlusion-aware person-search footprint of the whole hallway interior: it stops at the walls, floor and ceiling. */
export const HALLWAY_INTERIOR = union([box(vec3(4.06, 0, 3), vec3(7, 1.94, 5.6)), box(vec3(7, 0, 3), vec3(9.94, 1.94, 5.6))]);

export const ENVELOPE: MissionEnvelope = {
  runId: RUN_ID,
  revision: 1,
  approvedBy: COMMANDER,
  approvedTick: 0,
  regions: [box(vec3(-6, -3, 0), vec3(14, 6, 8))],
  maxSpeedMps: 2,
  ambientCeilingC: 70,
  endTick: 60_000,
};

/* Spray scenario. */

export const SPRAY_STANDOFF = vec3(5, 1, 4.2);
export const SPRAY_AIM = vec3(7, 1, 3.4);
export const FIRE_REGION = sphere(vec3(7, 1, 3.3), 0.4);
export const FIRE_OBS_ID: ObservationId = "obs-fire";
/** Footprint that covers the discharge sector plus the person margin. */
export const HALLWAY_VIEW = box(vec3(3, -1.5, 1.5), vec3(10.5, 3.5, 6.5));
/** Inside the standard discharge sector. */
export const PERSON_IN_SECTOR = vec3(6.5, 1.2, 3.8);

/* Breach scenario. */

export const WINDOW_ID = "window-rear";
export const BREACH_STANDOFF = vec3(-0.4, 2, 4.2);
export const STRIKE_POINT = vec3(-0.05, 2, 4.2);
/**
 * Footprint that covers the debris sphere, the columns its glass falls through (to the bedroom floor inside
 * and to the ground outside) and the person margin.
 */
export const WINDOW_VIEW = box(vec3(-3, -1, -0.5), vec3(3, 5, 7));

/* Occupant and routes. */

export const TRACK_ID = "track-1";
/** Far enough from the hallway sector and the window debris sphere that the occupant blocks neither. */
export const OCCUPANT_POSITION = vec3(3.5, 3.5, 3.9);
export const EVAC_ROUTE_ID = "route-evac";
export const RETURN_ROUTE_ID = "route-return";
export const EVAC_WAYPOINTS: readonly Vec3[] = [vec3(3, 2.5, 4), vec3(4.5, 1, 4), vec3(7, 1, 4), vec3(11, 2, 4)];

export interface ObservationOptions {
  readonly quality?: number;
  readonly detections?: readonly Detection[];
  readonly modality?: SensorModality;
  /** Default: thermal frames are person-search frames ("oracle_fixture"); RGB, lidar and ultrasound frames ran no person detector (null). */
  readonly personSearch?: DetectionMethod | null;
  readonly supersedes?: ObservationId | null;
}

export function observation(id: ObservationId, captureTick: Tick, footprint: Region | null, options: ObservationOptions = {}): Observation {
  const modality = options.modality ?? "rgb";
  const personSearch = options.personSearch !== undefined ? options.personSearch : modality === "thermal" ? "oracle_fixture" : null;
  return {
    id,
    runId: RUN_ID,
    sensorId: modality === "thermal" ? "thermal-front" : "rgb-front",
    modality,
    captureTick,
    arrivalTick: captureTick,
    frameId: `frame-${id}`,
    calibrationId: "calibration-fixture-1",
    provenance: "fixture",
    sensorPose: { position: SPRAY_STANDOFF, yawRad: 0, sigmaM: 0.1 },
    quality: options.quality ?? 0.9,
    footprint,
    personSearch,
    detections: options.detections ?? [],
    supersedes: options.supersedes ?? null,
  };
}

export function personDetection(position: Vec3, confidence = 0.6, uncertaintyM = 0.5): Detection {
  return { kind: "possible_person", position, uncertaintyM, confidence, method: "oracle_fixture" };
}

/** A thermal frame over the hallway that reports a possible person. */
export function personObservation(id: ObservationId, captureTick: Tick, position: Vec3 = PERSON_IN_SECTOR, confidence = 0.6): Observation {
  return observation(id, captureTick, HALLWAY_VIEW, { modality: "thermal", detections: [personDetection(position, confidence)] });
}

export function fireObservation(captureTick: Tick = FIRE_SEEN_TICK): Observation {
  return observation(FIRE_OBS_ID, captureTick, box(vec3(6, 0, 3), vec3(8, 2, 4.5)), {
    modality: "thermal",
    detections: [{ kind: "hazard", hazard: "fire", region: FIRE_REGION, intensity: 0.7 }],
  });
}

export function fireHazard(tick: Tick = FIRE_SEEN_TICK): HazardEvidence {
  return { observationId: FIRE_OBS_ID, tick, hazard: "fire", region: FIRE_REGION, intensity: 0.7 };
}

/** A thermal frame searched for people that saw no one: coverage, not proof of absence. Its footprint is authored, not an occlusion model. */
export function coverageObservation(captureTick: Tick, footprint: Region = HALLWAY_VIEW, quality = 0.9): Observation {
  return observation(`obs-cov-${captureTick}`, captureTick, footprint, { quality, modality: "thermal" });
}

export function occupantTrack(lastSeenTick: Tick, overrides: Partial<OccupantTrack> = {}): OccupantTrack {
  return {
    id: TRACK_ID,
    status: "possible",
    observationIds: ["obs-occupant-1"],
    position: OCCUPANT_POSITION,
    uncertaintyM: 0.5,
    roomId: "bedroom-rear",
    firstSeenTick: 400,
    lastSeenTick,
    confidence: 0.7,
    mergedInto: null,
    ambiguousWith: [],
    ...overrides,
  };
}

export function evacuationRoute(assessedTick: Tick, status: RouteAssessment["status"] = "supported"): RouteAssessment {
  return {
    id: EVAC_ROUTE_ID,
    purpose: "evacuation",
    waypoints: EVAC_WAYPOINTS,
    status,
    assessedTick,
    evidenceIds: [`obs-route-${assessedTick}`],
    estimatedDurationS: 20,
    reason: status === "supported" ? "fixture: hallway clear after suppression" : "fixture: hallway obstructed",
  };
}

/** The RGB frame an evacuation route assessed at `assessedTick` cites (it ran no person detector). */
export function routeObservation(assessedTick: Tick): Observation {
  return observation(`obs-route-${assessedTick}`, assessedTick, HALLWAY_VIEW);
}

export function returnRoute(assessedTick: Tick): RouteAssessment {
  return {
    id: RETURN_ROUTE_ID,
    purpose: "return",
    waypoints: [vec3(5, 1, 4.2), vec3(4.5, 1, 4.2), vec3(-1, 2, 4.2), vec3(-4, 2, 3)],
    status: "supported",
    assessedTick,
    evidenceIds: [`obs-return-${assessedTick}`],
    estimatedDurationS: 15,
    reason: "fixture: return path through the rear window observed clear",
  };
}

export function openingEvidence(tick: Tick, state: OpeningState = "closed"): OpeningEvidence {
  return { openingId: WINDOW_ID, state, tick, observationId: `obs-window-${tick}` };
}

export function windowObservation(captureTick: Tick, state: OpeningState = "closed"): Observation {
  return observation(`obs-window-${captureTick}`, captureTick, WINDOW_VIEW, { detections: [{ kind: "opening_state", openingId: WINDOW_ID, state }] });
}

export interface BeliefOptions {
  readonly runId?: RunId;
  readonly evidenceRevision?: number;
  readonly position?: Vec3;
  readonly sigmaM?: number;
  readonly poseSupported?: boolean;
  readonly aircraft?: Partial<AircraftStatusEstimate>;
  readonly observations?: readonly Observation[];
  readonly tracks?: readonly OccupantTrack[];
  readonly hazards?: readonly HazardEvidence[];
  readonly openings?: readonly OpeningEvidence[];
  readonly routes?: readonly RouteAssessment[];
  readonly mapChanges?: readonly MapChange[];
  readonly landing?: LandingSupport;
  readonly dispatchConfirmed?: boolean;
}

export function makeBelief(tick: Tick, options: BeliefOptions = {}): BeliefSnapshot {
  const mapChanges = options.mapChanges ?? [];
  return {
    runId: options.runId ?? RUN_ID,
    tick,
    evidenceRevision: options.evidenceRevision ?? 12,
    mapPrior: FLOOR_PLAN,
    mapRevision: FLOOR_PLAN.revision + mapChanges.length,
    mapChanges,
    pose: {
      tick,
      position: options.position ?? SPRAY_STANDOFF,
      yawRad: 0,
      velocity: vec3(0, 0, 0),
      sigmaM: options.sigmaM ?? 0.1,
      yawSigmaRad: 0.02,
      supported: options.poseSupported ?? true,
    },
    aircraft: { enduranceRemainingS: 600, waterRemainingL: 1, payloadsOnboard: [], ambientC: 40, thrustAvailableN: 60, ...options.aircraft },
    landing: options.landing ?? { supported: false, site: null, evidenceIds: [], reason: "fixture: no landing surface assessed" },
    observations: options.observations ?? [],
    reports: [],
    tracks: options.tracks ?? [],
    crewConfirmations: [],
    coverage: [],
    hazards: options.hazards ?? [],
    openings: options.openings ?? [],
    routes: options.routes ?? [],
    dispatchConfirmed: options.dispatchConfirmed ? { by: COMMANDER, tick: 0 } : null,
  };
}

export interface SceneOptions extends BeliefOptions {
  /** Capture tick of the fresh coverage frame; null omits it. Default: five ticks before the belief tick. */
  readonly coverageTick?: Tick | null;
  readonly coverageQuality?: number;
  /** Added after the scenario's standard observations. */
  readonly extraObservations?: readonly Observation[];
}

/** Belief supporting the standard spray: the fire frame, fresh hallway coverage and the aircraft at the standoff. */
export function sprayBelief(tick: Tick, options: SceneOptions = {}): BeliefSnapshot {
  const coverageTick = options.coverageTick === undefined ? tick - 5 : options.coverageTick;
  const coverage = coverageTick === null ? [] : [coverageObservation(coverageTick, HALLWAY_VIEW, options.coverageQuality)];
  return makeBelief(tick, {
    ...options,
    observations: [fireObservation(), ...coverage, ...(options.observations ?? []), ...(options.extraObservations ?? [])],
    hazards: options.hazards ?? [fireHazard()],
  });
}

/** Belief supporting the standard breach: the window seen closed, fresh coverage of the debris region and the aircraft at the standoff. */
export function breachBelief(tick: Tick, options: SceneOptions = {}): BeliefSnapshot {
  const coverageTick = options.coverageTick === undefined ? tick - 5 : options.coverageTick;
  const coverage = coverageTick === null ? [] : [coverageObservation(coverageTick, WINDOW_VIEW, options.coverageQuality)];
  return makeBelief(tick, {
    position: BREACH_STANDOFF,
    ...options,
    observations: [windowObservation(T0 - 20), ...coverage, ...(options.observations ?? []), ...(options.extraObservations ?? [])],
    openings: options.openings ?? [openingEvidence(T0 - 20)],
  });
}

export function makeContext(belief: BeliefSnapshot, overrides: Partial<Omit<HarnessContext, "belief" | "tick">> = {}): HarnessContext {
  return { tick: belief.tick, missionStartTick: 0, profile: TENDER_T1, policy: DEFAULT_POLICY, envelope: ENVELOPE, belief, ...overrides };
}

export function proposalInput(action: ActionSpec, overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    runId: RUN_ID,
    aircraftId: TENDER_T1.id,
    proposer: "local_planner",
    action,
    rationale: `fixture: ${action.kind}`,
    citedEvidence: [],
    basis: BASIS,
    createdTick: T0,
    expiresTick: T0 + 3000,
    ...overrides,
  };
}

export function sprayAction(overrides: Partial<Extract<ActionSpec, { kind: "spray" }>> = {}): ActionSpec {
  return { kind: "spray", standoff: SPRAY_STANDOFF, aimPoint: SPRAY_AIM, flowLps: 0.2, durationTicks: 300, ...overrides };
}

export function sprayInput(overrides: Partial<ProposalInput> = {}, action: Partial<Extract<ActionSpec, { kind: "spray" }>> = {}): ProposalInput {
  return proposalInput(sprayAction(action), { rationale: "Suppress the small fire blocking the hallway exit.", citedEvidence: [FIRE_OBS_ID], ...overrides });
}

export function breachInput(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return proposalInput(
    { kind: "breach_opening", openingId: WINDOW_ID, standoff: BREACH_STANDOFF, strikePoint: STRIKE_POINT },
    { rationale: "Open the rear window for access; no observed opening is available.", citedEvidence: [`obs-window-${T0 - 20}`], ...overrides },
  );
}

export function moveInput(goal: Vec3, overrides: Partial<ProposalInput> = {}): ProposalInput {
  return proposalInput({ kind: "move", goal, maxSpeedMps: 1.5 }, overrides);
}

export function guideInput(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return proposalInput(
    { kind: "guide", trackId: TRACK_ID, routeId: EVAC_ROUTE_ID, templateIds: ["follow-light", "stay-low"], maxDurationTicks: 600 },
    { rationale: "Guide the possible occupant along the reassessed hallway route.", ...overrides },
  );
}

/** A contingency hold, as the mission loop would submit after an abort. */
export function contingencyHoldInput(createdTick: Tick, overrides: Partial<ProposalInput> = {}): ProposalInput {
  return proposalInput({ kind: "hold", durationTicks: 500 }, { proposer: "contingency", rationale: "fixture: bounded hold contingency", createdTick, expiresTick: createdTick + 1000, ...overrides });
}

export function approveCommand(proposalId: ProposalId, digest: string, tick: Tick, overrides: Partial<ApproveCommand> = {}): ApproveCommand {
  return { type: "approve", runId: RUN_ID, proposalId, digest, commanderId: COMMANDER, tick, ...overrides };
}

export function executeCommand(proposalId: ProposalId, digest: string, requestId: string, tick: Tick, overrides: Partial<ExecuteCommand> = {}): ExecuteCommand {
  return { type: "execute", runId: RUN_ID, proposalId, digest, requestId, tick, ...overrides };
}
