/**
 * Fixtures for the motion-guard and contingency tests. Every value here is authored test input (a
 * fixture), not simulator output, and the belief snapshots carry no world truth.
 *
 * Layout (world frame, metres, Z up): the envelope is the box x 0–20, y 0–10, z 0–6. The aircraft starts at
 * its centre (10, 5, 3) facing +x (east) with σ 0.2 m. Aircraft: Tender T1 (4 m/s, 1.5 m/s vertical,
 * 3 m/s², 120 s return reserve); envelope speed 2 m/s; default harness policy. No possible occupant unless a
 * test adds tracks or observations.
 */
import type { ActionProposal, ActionSpec, MotionCommand, MotionRequest, MotionSource, Proposer } from "../contracts/actions.ts";
import type { AircraftProfile } from "../contracts/aircraft.ts";
import { TENDER_T1 } from "../contracts/aircraft.ts";
import { digestOf } from "../contracts/canonical.ts";
import type { Tick } from "../contracts/clock.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import type { AircraftStatusEstimate, BeliefSnapshot, EstimatedPose, FloorPlanPrior, LandingSupport, OccupantTrack, RouteAssessment } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { vec3 } from "../contracts/frames.ts";
import { box } from "../contracts/geometry.ts";
import type { ObservationId, RouteId, TrackId } from "../contracts/ids.ts";
import type { Observation } from "../contracts/observation.ts";
import type { MotionGuardState } from "./motion-guard.ts";
import type { HarnessContext, HarnessPolicy } from "./policy.ts";
import { DEFAULT_POLICY } from "./policy.ts";

export { DEFAULT_POLICY, TENDER_T1 };

export const RUN_ID = "run-motion";
export const NOW: Tick = 5000;
export const START: Vec3 = vec3(10, 5, 3);

export const ENVELOPE: MissionEnvelope = {
  runId: RUN_ID,
  revision: 3,
  approvedBy: "commander-1",
  approvedTick: 0,
  regions: [box(vec3(0, 0, 0), vec3(20, 10, 6))],
  maxSpeedMps: 2,
  ambientCeilingC: 70,
  endTick: 60_000,
};

/** Map prior revision; no map changes, so the current map revision equals it. */
export const MAP_REVISION = 7;
export const EVIDENCE_REVISION = 42;

const PRIOR: FloorPlanPrior = {
  revision: MAP_REVISION,
  source: "fixture: motion-guard test layout",
  floors: [{ index: 0, elevationM: 0, ceilingM: 6 }],
  rooms: [],
  openings: [],
  exits: [],
  assemblyPoint: box(vec3(22, 0, 0), vec3(24, 2, 2)),
};

export function pose(overrides: Partial<EstimatedPose> = {}): EstimatedPose {
  return { tick: NOW, position: START, yawRad: 0, velocity: vec3(0, 0, 0), sigmaM: 0.2, yawSigmaRad: 0.02, supported: true, ...overrides };
}

export const NO_LANDING: LandingSupport = { supported: false, site: null, evidenceIds: ["obs-us-down-rough"], reason: "fixture: downward ultrasound returns are too scattered to confirm a surface" };

export function landingAt(site: Vec3 = vec3(10, 5, 0), evidenceIds: readonly ObservationId[] = ["obs-us-down"]): LandingSupport {
  return { supported: true, site, evidenceIds, reason: "fixture: downward ultrasound reports a flat surface below" };
}

export interface RouteOptions {
  readonly status?: RouteAssessment["status"];
  readonly assessedTick?: Tick;
  readonly durationS?: number;
  readonly evidenceIds?: readonly ObservationId[];
  readonly waypoints?: readonly Vec3[];
}

export function route(id: RouteId, purpose: RouteAssessment["purpose"], options: RouteOptions = {}): RouteAssessment {
  const status = options.status ?? "supported";
  return {
    id,
    purpose,
    waypoints: options.waypoints ?? [START, vec3(2, 5, 3), vec3(0.5, 5, 1)],
    status,
    assessedTick: options.assessedTick ?? NOW - 100,
    evidenceIds: options.evidenceIds ?? [`obs-${id}`],
    estimatedDurationS: options.durationS ?? 90,
    reason: status === "supported" ? "fixture: fresh lidar shows the route open" : "fixture: lidar shows debris across the route",
  };
}

export interface BeliefOptions {
  readonly tick?: Tick;
  readonly pose?: Partial<EstimatedPose>;
  readonly aircraft?: Partial<AircraftStatusEstimate>;
  readonly landing?: LandingSupport;
  readonly routes?: readonly RouteAssessment[];
  readonly hazards?: BeliefSnapshot["hazards"];
  readonly tracks?: readonly OccupantTrack[];
  readonly observations?: readonly Observation[];
}

export function belief(options: BeliefOptions = {}): BeliefSnapshot {
  const tick = options.tick ?? NOW;
  return {
    runId: RUN_ID,
    tick,
    evidenceRevision: EVIDENCE_REVISION,
    mapPrior: PRIOR,
    mapRevision: MAP_REVISION,
    mapChanges: [],
    pose: pose({ tick, ...options.pose }),
    aircraft: { enduranceRemainingS: 600, waterRemainingL: 1, payloadsOnboard: [], ambientC: 40, thrustAvailableN: 60, ...options.aircraft },
    landing: options.landing ?? NO_LANDING,
    observations: options.observations ?? [],
    reports: [],
    tracks: options.tracks ?? [],
    crewConfirmations: [],
    coverage: [],
    hazards: options.hazards ?? [],
    openings: [],
    routes: options.routes ?? [],
    dispatchConfirmed: null,
  };
}

export interface ContextOptions extends BeliefOptions {
  readonly envelope?: Partial<MissionEnvelope>;
  readonly policy?: Partial<HarnessPolicy>;
  readonly profile?: AircraftProfile;
}

export function context(options: ContextOptions = {}): HarnessContext {
  const tick = options.tick ?? NOW;
  return {
    tick,
    missionStartTick: 0,
    profile: options.profile ?? TENDER_T1,
    policy: { ...DEFAULT_POLICY, ...options.policy },
    envelope: { ...ENVELOPE, ...options.envelope },
    belief: belief({ ...options, tick }),
  };
}

/** A registered proposal with a real digest; the id is derived from the digest, so it is deterministic. */
export function proposal(action: ActionSpec, proposer: Proposer = "local_planner", createdTick: Tick = NOW - 10): ActionProposal {
  const input = {
    runId: RUN_ID,
    aircraftId: TENDER_T1.id,
    proposer,
    action,
    rationale: "fixture proposal",
    citedEvidence: [],
    basis: { evidenceRevision: EVIDENCE_REVISION, mapRevision: MAP_REVISION, profileRevision: TENDER_T1.revision, envelopeRevision: ENVELOPE.revision, policyRevision: DEFAULT_POLICY.revision },
    createdTick,
    expiresTick: createdTick + DEFAULT_POLICY.maxProposalLifetimeTicks,
  };
  const digest = digestOf(input);
  return { ...input, id: `proposal-${digest.slice(0, 12)}`, digest };
}

/** Planner move toward the east wall, allowed up to 3 m/s by the proposal (the envelope caps it at 2). */
export const PLANNER_MOVE = proposal({ kind: "move", goal: vec3(18, 5, 3), maxSpeedMps: 3 });
export const SLOW_MOVE = proposal({ kind: "move", goal: vec3(18, 5, 3), maxSpeedMps: 1.5 });
export const PLANNER_SCAN = proposal({ kind: "scan", lookAt: vec3(15, 5, 2), durationTicks: 300 });
export const PLANNER_LAND = proposal({ kind: "land", site: vec3(10, 5, 0) });
export const CONTINGENCY_RETURN = proposal({ kind: "return", routeId: "route-home" }, "contingency");
export const CONTINGENCY_LAND = proposal({ kind: "land", site: vec3(10, 5, 0) }, "contingency");
export const CONTINGENCY_HOLD = proposal({ kind: "hold", durationTicks: 600 }, "contingency");
/** A contingency proposer cannot make a non-contingency kind (move) survive an abort. */
export const CONTINGENCY_MOVE = proposal({ kind: "move", goal: vec3(18, 5, 3), maxSpeedMps: 3 }, "contingency");

/**
 * A possible-occupant track (fixture evidence, not a detector result): confidence 0.7, no uncertainty unless
 * given, last seen ten ticks ago.
 */
export function track(id: TrackId, position: Vec3, overrides: Partial<OccupantTrack> = {}): OccupantTrack {
  return {
    id,
    status: "possible",
    observationIds: [`obs-${id}`],
    position,
    uncertaintyM: 0,
    roomId: null,
    firstSeenTick: NOW - 500,
    lastSeenTick: NOW - 10,
    confidence: 0.7,
    mergedInto: null,
    ambiguousWith: [],
    ...overrides,
  };
}

export const STILL: MotionCommand = { velocityBody: vec3(0, 0, 0), yawRateRadps: 0 };

export function command(x: number, y: number, z: number, yawRateRadps = 0): MotionCommand {
  return { velocityBody: vec3(x, y, z), yawRateRadps };
}

export function motionRequest(x: number, y: number, z: number, yawRateRadps = 0, source: MotionSource = "fly_readout", tick: Tick = NOW): MotionRequest {
  return { source, tick, velocityBody: vec3(x, y, z), yawRateRadps };
}

export function guardState(overrides: Partial<MotionGuardState> = {}): MotionGuardState {
  return { activeMotion: PLANNER_MOVE, interventionActive: false, sprayActive: false, missionAborted: false, terminalFailure: false, previous: STILL, ...overrides };
}
