/**
 * Deterministic mission candidate factory.
 *
 * From the truth-free belief snapshot, the aircraft profile, the commander-approved mission envelope and
 * the harness policy, build complete ProposalInput candidates with stable ids and plain descriptions for
 * the mission tools of architecture.md §6, plus the non-proposal choices `defer` and
 * `request_human_review`. The factory never approves anything, never reads simulator truth and never marks
 * a room empty: an inspection is only an observation goal. Every candidate is a proposal that the harness
 * validates again before approval, before execution and on every executing tick. The pre-filters here only
 * avoid offering choices the harness would certainly reject, such as breaking a window last seen open.
 *
 * Breach candidates carry a BreachAccess assessment (see the request_breach section) that the local planner
 * scores, and the set's notes say in words why a window was left out or ranks low. No spray is offered at a fire
 * water is unsafe for (H19's fire-class evidence) or at a fire sprayed since its latest sighting (H14's look
 * before spraying again); the aircraft looks at such a fire instead (request_suppression section).
 *
 * Time comes only from the snapshot (`belief.tick`); the same inputs always produce the same set.
 */
import type { ActionSpec, Proposer, ProposalBasis, ProposalInput } from "../../contracts/actions.ts";
import { SPEECH_TEMPLATES } from "../../contracts/actions.ts";
import type { AircraftProfile, GlassBreakerSpec, SensorSpec, WaterModuleSpec } from "../../contracts/aircraft.ts";
import { sha256Hex } from "../../contracts/canonical.ts";
import type { Tick } from "../../contracts/clock.ts";
import { TICK_S } from "../../contracts/clock.ts";
import type { MissionEnvelope } from "../../contracts/envelope.ts";
import { envelopeContains } from "../../contracts/envelope.ts";
import type { BeliefSnapshot, CoverageState, FireClassAssessment, FloorPlanPrior, HazardEvidence, OccupantTrack, OpeningEvidence, RoomCoverage, RouteAssessment } from "../../contracts/evidence.ts";
import type { Pose, Vec3 } from "../../contracts/frames.ts";
import { add, bodyPointToWorld, distance, dot, horizontalDistance, rotateWorldToBody, scale, sub, vec3, yawBetween } from "../../contracts/frames.ts";
import type { Point2, Region } from "../../contracts/geometry.ts";
import { distanceToRegion, pointInPolygon, prism, regionBounds, regionContains, representativePoint } from "../../contracts/geometry.ts";
import type { ObservationId, OpeningId, RoomId, RouteId, TrackId } from "../../contracts/ids.ts";
import { deepFreeze } from "../../contracts/ids.ts";
import { searchedFractionSince } from "../../evidence/coverage.ts";
import { assessFireClass } from "../../evidence/fire-class.ts";
import { roomContaining } from "../../evidence/rooms.ts";
import { requiredSamples } from "../../harness/coverage.ts";
import type { PossibleOccupant } from "../../harness/person-clearance.ts";
import { clearedByLaterLook, guideLeadIndex, isCurrentOccupant, nearestIndex, personClearanceFor, possibleOccupants, requiredPersonDistanceM } from "../../harness/person-clearance.ts";
import type { BreachSpec } from "../../harness/effects.ts";
import { affectedRegion, sprayRegion } from "../../harness/effects.ts";
import type { HarnessContext, HarnessPolicy } from "../../harness/policy.ts";
import { riskClassOf } from "../../harness/policy.ts";
import type { SprayDischarge } from "../../harness/respray.ts";
import { sprayAfterSighting } from "../../harness/respray.ts";
import { sprayFireClass } from "../../harness/rules.ts";
import { assessRoute } from "../routes/index.ts";
import { direction2, insidePolygon, nearestBoundaryPoint, pointBoundaryDistance } from "../routes/plane.ts";
import { passableFor, ROUTE_EVIDENCE_MAX_AGE_TICKS, ROUTE_MIN_FRESH_SEARCHED_FRACTION } from "../routes/support.ts";
import { breachAccessScore, TIGHT_FIT, UNCONFIRMED_ACCESS_FACTOR, unconfirmedAccessScore } from "./access-score.ts";
import type { BreachAccess, CandidateSet, CandidateTarget, ChoiceCandidate, MissionCandidate, MissionTool, ProposalCandidate } from "./types.ts";
import { clip, compareText, sanitizeText } from "./text.ts";
import { MAX_DESCRIPTION_LENGTH, TOOL_ORDER } from "./types.ts";

export interface CandidateFactoryInput {
  readonly belief: BeliefSnapshot;
  readonly profile: AircraftProfile;
  readonly envelope: MissionEnvelope;
  readonly policy: HarnessPolicy;
  /** Tick of the latest breach or spray with physical effects; guidance needs a route assessed after it. */
  readonly lastInterventionTick?: Tick | null;
  /** Candidate ids to leave out, e.g. one the commander just rejected, so another option surfaces. */
  readonly omitCandidateIds?: readonly string[];
  /** Attribution of the candidate proposals; the broker re-attributes the chosen one to its decider. */
  readonly proposer?: Proposer;
  /**
   * The station the aircraft is moving to or holding for the candidate chosen last. That candidate keeps the
   * station across re-plans while the station still meets its constraints and no other is materially better,
   * so sighting jitter does not send the aircraft back and forth between near-equal stations.
   */
  readonly incumbent?: Incumbent | null;
  /** Points left out for a while (stalled, or refused for coverage twice): no station is chosen within their radius. */
  readonly avoid?: readonly AvoidedPoint[];
  /**
   * Intervention candidates left out only while they cool after a refusal for coverage, to be retried from
   * their station: observation moves away from that station are not offered meanwhile.
   */
  readonly retrying?: readonly string[];
  /**
   * Whether the aircraft can fly to a station now (the runtime passes its flight-path test, which also keeps
   * clear of burning fire). Stations are chosen among reachable ones, so an unreachable first choice does not
   * drop the candidate. Defaults to every station being reachable.
   */
  readonly reachable?: (station: Vec3) => boolean;
  /** Tracks guidance has run for (every guide that began executing); see the after-guidance section. */
  readonly guided?: readonly GuidedTrack[];
  /**
   * Sprays that discharged water or are discharging (harness respray.ts sprayDischarges of the harness records):
   * no further spray is offered at a fire one of them reached until a sighting captured after it still shows flame.
   */
  readonly sprays?: readonly SprayDischarge[];
}

/** A guide that began executing: the track it led, along which route, and when it started. */
export interface GuidedTrack {
  readonly trackId: TrackId;
  readonly routeId: RouteId;
  readonly sinceTick: Tick;
}

export interface AvoidedPoint {
  readonly point: Vec3;
  readonly radiusM: number;
}

export interface Incumbent {
  readonly candidateId: string;
  readonly station: Vec3;
}

/** Routine candidates are re-planned often and expire after 10 s; interventions get the policy maximum. */
const ROUTINE_LIFETIME_TICKS = 1000;
const SCAN_TICKS = 200;
const VERTICAL_ARRIVAL_M = 0.5;
/** Exterior viewpoint distance in front of a room's exterior opening. */
const EXTERIOR_VIEW_DISTANCE_M = 2;
/** Second-viewpoint radius around a possible occupant: its uncertainty plus 1.5 m, at most 3 m. */
const SECOND_VIEW_STANDOFF_M = 1.5;
const MAX_SECOND_VIEW_M = 3;
const MIN_NEW_VIEW_M = 1;
/** Bearings tried for a second viewpoint, relative to the line from the lead to the aircraft: rotated away first. */
const SECOND_VIEW_ANGLES_RAD = [60, -60, 120, -120, 90, -90, 30, -30, 150, -150, 180, 0].map(deg => (deg * Math.PI) / 180);
/** Radii tried beyond the required person clearance for a second viewpoint. */
const SECOND_VIEW_EXTRA_RADII_M = [0, 0.3, 0.6];
/** Kept beyond the person clearance (aircraft edge to the person, plus the track's uncertainty) at a station. */
const PERSON_STATION_MARGIN_M = 0.2;
/** Possible occupants more than this far above or below a station are on another floor. */
const PERSON_SAME_FLOOR_M = 2.5;
/** Doorway second looks: distances from the door into the neighbouring room, and offsets along the wall. */
const DOORWAY_VIEW_DEPTHS_M = [1.0, 1.4, 0.7, 1.8];
const DOORWAY_VIEW_OFFSETS_M = [0, 0.4, -0.4];
/** A doorway view's sight line to the lead passes the door this far inside its jambs. */
const DOOR_SIGHT_MARGIN_M = 0.05;
/** Approach points of an exit lie this far beyond the opening (the route graph's APPROACH_M). */
const EXIT_APPROACH_M = 0.6;
const ACCESS_SAMPLE_STEP_M = 0.1;
/** While a spray cools after a coverage refusal, the aircraft is not sent farther than this from its station. */
const SPRAY_HOLD_RADIUS_M = 2.0;
/** Demo: the standoff at 60% of the striker reach, so the station the look ends at (within the 0.3 m arrival tolerance) is already within reach less the strike margin. */
const BREACH_REACH_FRACTION = 0.6;
/** Suppression standoff: at most 60% of the jet range, and at most 2.5 m, from the aim point. */
const SPRAY_RANGE_FRACTION = 0.6;
const MAX_SPRAY_STANDOFF_M = 2.5;
/** Standoff distances searched: the longest reach, then this much nearer each time (2.4 down to 1.2 m for Tender T1; the fire's clearance rules out the nearest for a large fire). */
const SPRAY_REACH_STEPS_M = [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.2];
/** Bearings searched around the aim point, evenly spaced from east, whatever the aircraft's position. */
const SPRAY_STANDOFF_BEARINGS = 12;
const SPRAY_STANDOFF_RISE_M = 0.5;
const FIRE_CLEARANCE_M = 0.8;
/** Kept beyond FIRE_CLEARANCE_M from the fire region (1.1 m in all: steering forbids legs within 1.0 m of a burning fire). */
const FIRE_CLEARANCE_MARGIN_M = 0.3;
/** Kept beyond the jet cone's radius between the standoff→aim line and every wall and corner. */
const JET_CLEARANCE_MARGIN_M = 0.2;
/** The last part of the jet line runs into the fire, which may stand against a wall; it is not checked for grazing. */
const JET_END_SLACK_M = 0.5;
const JET_SAMPLE_STEP_M = 0.1;
/**
 * Visible-share estimates this close count as equal: the estimate reads 15-30 points above real coverage, so
 * smaller differences carry no information. Among equals the shorter reach wins (a shorter jet region, seen
 * from closer through less smoke: on Troy the 1.2 m standoff passed H6 at 100% where the 1.6 m one, estimated
 * a point higher, reached 93.8%), and the incumbent is kept unless another is better by more than this.
 */
const SPRAY_SHARE_MARGIN = 0.05;
const MIN_AIM_DISTANCE_M = 0.05;
/** DEMO: one decisive spray of about 1 s at the Tender's 0.2 L/s (was 0.3 L); see the fire model's suppression rate. */
const SUPPRESSION_DOSE_L = 0.2;
const MIN_SUPPRESSION_DOSE_L = 0.05;
const WATER_DENSITY_KG_M3 = 1000;
const GUIDE_DURATION_FACTOR = 2;
const GUIDE_DURATION_EXTRA_S = 30;
const MAX_DURATION_TICKS = 60_000;
const MAX_CITED = 8;
const MAX_RETURN_CANDIDATES = 2;
const MAX_RATIONALE_LENGTH = 600;

type PriorRoom = FloorPlanPrior["rooms"][number];
export type PriorOpening = FloorPlanPrior["openings"][number];

interface Ctx {
  readonly belief: BeliefSnapshot;
  readonly prior: FloorPlanPrior;
  readonly profile: AircraftProfile;
  readonly envelope: MissionEnvelope;
  readonly policy: HarnessPolicy;
  readonly now: Tick;
  readonly basis: ProposalBasis;
  readonly proposer: Proposer;
  readonly pose: Vec3;
  readonly speedMps: number;
  /** The estimated position is in no prior room. */
  readonly outside: boolean;
  readonly rooms: ReadonlyMap<RoomId, PriorRoom>;
  readonly latestOpening: ReadonlyMap<OpeningId, OpeningEvidence>;
  /** Exterior openings whose latest observation, within the cited-evidence age, shows them open or broken. */
  readonly openEntries: readonly PriorOpening[];
  /** Observations a proposal may cite: present, not superseded and within the cited-evidence age. */
  readonly citable: ReadonlySet<ObservationId>;
  readonly reportedRooms: ReadonlySet<RoomId>;
  readonly lastInterventionTick: Tick | null;
  /** Where routes from outside start: the pose, moved out of a facade's wall band; null inside a room's footprint or when it cannot be placed clear. */
  readonly start: Vec3 | null;
  /** Candidate ids left out of this set (e.g. cooling after a rejection or a completed look). */
  readonly omitted: ReadonlySet<string>;
  readonly incumbent: Incumbent | null;
  readonly avoid: readonly AvoidedPoint[];
  readonly retrying: ReadonlySet<string>;
  /** Possible occupants stations keep clear of (harness person-clearance.ts): every possible track, and the newest detections not cleared by a later look. */
  readonly occupants: readonly PossibleOccupant[];
  readonly reachable: (station: Vec3) => boolean;
  /** The harness's view of this snapshot, for the person-clearance helpers. */
  readonly harness: HarnessContext;
  /** Guided people (after-guidance section), one per current track. */
  readonly escorts: readonly Escort[];
  /** Tracks guidance has run for: the guided ids, the tracks they merged into, and tracks marked as possibly the same person. */
  readonly guidedIds: ReadonlySet<TrackId>;
  /** Drone paths computed for this set (dronePath), by endpoints. */
  readonly paths: Map<string, readonly Vec3[] | null>;
  readonly sprays: readonly SprayDischarge[];
  /** Fire-class assessments computed for this set (fireClassOf), by sighting. */
  readonly fireClasses: Map<HazardEvidence, FireClassAssessment>;
}

interface CandidateSpec {
  readonly id: string;
  readonly tool: MissionTool;
  readonly description: string;
  readonly rationale: string;
  readonly target: CandidateTarget;
  readonly action: ActionSpec;
  readonly cited: readonly ObservationId[];
}

/** A note for CandidateSet.notes, tied to the candidate it explains (null when it explains a choice that was not offered). */
interface Note {
  readonly candidateId: string | null;
  readonly text: string;
}

const MAX_NOTES = 24;
const MAX_NOTE_LENGTH = 320;

/** Build the candidate set for the snapshot. The result is deeply frozen. */
export function buildCandidateSet(input: CandidateFactoryInput): CandidateSet {
  const ctx = factoryContext(input);
  const gateReason = globalGate(ctx);
  const omitted = ctx.omitted;
  const notes: Note[] = [];
  const proposals = gateReason === null ? uniqueById(proposalCandidates(ctx, notes)).filter(candidate => !omitted.has(candidate.id)) : [];
  const candidates: MissionCandidate[] = [...proposals.sort(compareCandidates), deferCandidate(gateReason), humanReviewCandidate()];
  return deepFreeze({
    runId: ctx.belief.runId,
    aircraftId: ctx.profile.id,
    tick: ctx.now,
    evidenceRevision: ctx.belief.evidenceRevision,
    basis: ctx.basis,
    gateReason,
    candidates,
    notes: notes.filter(note => note.candidateId === null || !omitted.has(note.candidateId)).slice(0, MAX_NOTES).map(note => clip(note.text, MAX_NOTE_LENGTH)),
  });
}

/** The candidate an offered id names, or null. Decisions resolve ids only through this lookup. */
export function resolveCandidate(set: CandidateSet, id: string): MissionCandidate | null {
  return set.candidates.find(candidate => candidate.id === id) ?? null;
}

/**
 * Stable candidate id: the tool plus target ids. Characters outside [A-Za-z0-9_.-] and over-long parts
 * are replaced, with a short hash of the original so that distinct targets never share an id.
 */
export function candidateId(tool: MissionTool, ...parts: readonly string[]): string {
  return [tool, ...parts.map(idPart)].join(":");
}

function idPart(raw: string): string {
  const safe = raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 28);
  return safe.length > 0 && safe === raw ? safe : `${safe}~${sha256Hex(raw).slice(0, 8)}`;
}

export function compareCandidates(a: MissionCandidate, b: MissionCandidate): number {
  return TOOL_ORDER.indexOf(a.tool) - TOOL_ORDER.indexOf(b.tool) || compareText(a.id, b.id);
}

function factoryContext(input: CandidateFactoryInput): Ctx {
  const { belief, profile, envelope, policy } = input;
  const now = belief.tick;
  const freshFrom = now - policy.citedEvidenceMaxAgeTicks;
  const latestOpening = latestOpeningEvidence(belief.openings);
  const outside = roomContaining(belief.mapPrior, belief.pose.position) === null;
  const harness: HarnessContext = { tick: now, missionStartTick: envelope.approvedTick, profile, policy, envelope, belief };
  // Every possible track (a later look that missed someone may have been occluded), and the newest detections not cleared since.
  const occupants = possibleOccupants(harness).filter(o => o.source === "track" || isCurrentOccupant(o, harness));
  const escorts = escortsOf(input.guided ?? [], harness);
  return {
    belief,
    prior: belief.mapPrior,
    profile,
    envelope,
    policy,
    now,
    basis: { evidenceRevision: belief.evidenceRevision, mapRevision: belief.mapRevision, profileRevision: profile.revision, envelopeRevision: envelope.revision, policyRevision: policy.revision },
    proposer: input.proposer ?? "local_planner",
    pose: belief.pose.position,
    speedMps: Math.min(envelope.maxSpeedMps, profile.hardLimits.maxSpeedMps),
    outside,
    rooms: new Map(belief.mapPrior.rooms.map(room => [room.id, room])),
    latestOpening,
    openEntries: observedOpenEntries(belief, latestOpening, freshFrom),
    citable: citableObservations(belief, freshFrom),
    reportedRooms: reportedRooms(belief),
    lastInterventionTick: input.lastInterventionTick ?? null,
    start: outside ? exteriorStart(belief.pose.position, belief.mapPrior, policy) : null,
    omitted: new Set(input.omitCandidateIds ?? []),
    incumbent: input.incumbent ?? null,
    avoid: input.avoid ?? [],
    retrying: new Set(input.retrying ?? []),
    occupants,
    harness,
    reachable: input.reachable ?? (() => true),
    escorts,
    guidedIds: guidedTrackIds(belief, input.guided ?? [], escorts),
    paths: new Map(),
    sprays: input.sprays ?? [],
    fireClasses: new Map(),
  };
}

/** Conditions under which the harness would reject every planner proposal; null when none applies. */
function globalGate(ctx: Ctx): string | null {
  const { belief, envelope, profile, policy } = ctx;
  const ambientC = belief.aircraft.ambientC;
  const ambientLimitC = Math.min(profile.hardLimits.maxAmbientC, envelope.ambientCeilingC);
  if (envelope.runId !== belief.runId) return `the mission envelope belongs to run ${envelope.runId}, not ${belief.runId}`;
  if (ctx.now > envelope.endTick) return "the mission envelope's time box has ended; only contingencies remain";
  if (!belief.pose.supported) return "localization does not currently support movement";
  if (belief.pose.sigmaM > policy.maxSigmaForAdvanceM) return `pose uncertainty ${fmt(belief.pose.sigmaM)} m exceeds the ${fmt(policy.maxSigmaForAdvanceM)} m allowed for movement`;
  if (ambientC === null) return "ambient temperature is unknown";
  if (ambientC > ambientLimitC) return `ambient ${fmt(ambientC)} °C exceeds the ${fmt(ambientLimitC)} °C limit`;
  if (!(ctx.speedMps > 0)) return "the mission envelope permits no movement";
  return null;
}

function proposalCandidates(ctx: Ctx, notes: Note[]): ProposalCandidate[] {
  const sprays = suppressionCandidates(ctx, notes);
  const rechecks = sprayedFires(ctx);
  const relooks = keepOffWaysOut(ctx, rechecks.map(r => fireRecheckCandidate(ctx, r)), notes);
  const hold = sprayHold(ctx, sprays);
  const away = (c: ProposalCandidate) => hold !== null && c.target.station !== null && distance(c.target.station, hold) > SPRAY_HOLD_RADIUS_M;
  let looks = keepOffWaysOut(ctx, [...inspectCandidates(ctx, notes), ...investigateCandidates(ctx, notes), ...routeSweepCandidates(ctx)], notes);
  // Right after a spray, seeing whether the fire still burns comes first: nothing else is looked at meanwhile.
  if (relooks.length > 0 && rechecks.some(r => recheckUrgent(ctx, r.spray)) && looks.length > 0) {
    notes.push({ candidateId: null, text: `Looking at the sprayed fire again before anything else, for up to ${fmt(POST_SPRAY_LOOK_TICKS * TICK_S)} s after the spray: not offering ${idList(looks)}.` });
    looks = [];
  }
  const withheld = looks.filter(away);
  if (hold !== null && withheld.length > 0) {
    notes.push({ candidateId: null, text: `Holding within ${fmt(SPRAY_HOLD_RADIUS_M)} m of the spray standoff while the spray waits to be retried: not offering ${idList(withheld)}.` });
  }
  return [
    ...relooks,
    ...looks.filter(c => !away(c)),
    ...standClearCandidates(ctx, notes),
    ...returnRefreshCandidates(ctx, notes),
    ...breachCandidates(ctx, notes),
    ...sprays,
    ...guideCandidates(ctx),
    ...returnCandidates(ctx, notes),
  ];
}

function idList(candidates: readonly ProposalCandidate[]): string {
  return `${candidates.map(c => c.id).slice(0, 4).join(", ")}${candidates.length > 4 ? " and more" : ""}`;
}

/**
 * The station of a spray that is on offer but left out of this set while it cools after a coverage refusal,
 * to be retried: finishing that intervention comes first, so observation moves farther than
 * SPRAY_HOLD_RADIUS_M from its station (a second look in the occupant's room, say) are not offered meanwhile.
 * A spray left out for any other reason (a commander's rejection) holds nothing. Null otherwise.
 */
function sprayHold(ctx: Ctx, sprays: readonly ProposalCandidate[]): Vec3 | null {
  return sprays.find(c => ctx.omitted.has(c.id) && ctx.retrying.has(c.id))?.target.station ?? null;
}

/*
 * inspect_room: an observation goal for a room not yet adequately person-searched. The run-wide coverage
 * state is not used: a frame glimpsing one corner makes a room "observed" without searching it. A room is
 * offered while less than INSPECT_SEARCHED_FRACTION of it has been person-searched at adequate quality, or
 * while an evacuation route through it is unknown and the room lacks the fresh post-intervention search the
 * route assessor needs (ROUTE_MIN_FRESH_SEARCHED_FRACTION).
 */
const INSPECT_SEARCHED_FRACTION = 0.5;

interface Viewpoint {
  readonly goal: Vec3;
  readonly lookAt: Vec3;
  readonly via: string;
}

function inspectCandidates(ctx: Ctx, notes: Note[]): ProposalCandidate[] {
  const coverage = new Map(ctx.belief.coverage.map(entry => [entry.roomId, entry]));
  const routeRooms = staleRouteRooms(ctx, coverage);
  return ctx.prior.rooms.flatMap(room => {
    const entry = coverage.get(room.id);
    const state: CoverageState = entry?.state ?? "unobserved";
    const searched = searchedFraction(entry);
    const forRoute = routeRooms.has(room.id);
    if (searched >= INSPECT_SEARCHED_FRACTION && !forRoute) return [];
    const view = roomViewpoint(ctx, room, notes);
    if (view === null) return [];
    const action = inspectAction(ctx, view);
    const durationS = action.kind === "scan" ? action.durationTicks * TICK_S : travelS(ctx, view.goal);
    if (!keepsReserve(ctx, durationS)) return [];
    const lastObserved = entry?.lastObservedTick ?? null;
    const roomName = roomLabel(room);
    const verb = action.kind === "scan" ? "Scan" : "Move to observe";
    const routeNote = forRoute ? " An evacuation route through it needs a fresh search." : "";
    const description = `${verb} ${roomName} (${state}, ${Math.round(searched * 100)}% person-searched) ${view.via}.${routeNote} Observation only; it does not mark the room empty.`;
    const history = lastObserved === null ? "It has not been observed." : `It was last observed ${ageText(ctx, lastObserved)} ago.`;
    const reported = ctx.reportedRooms.has(room.id) ? " A report names this room." : "";
    return [build(ctx, {
      id: candidateId("inspect_room", room.id),
      tool: "inspect_room",
      description,
      rationale: `${description} ${history}${reported}`,
      target: target({ roomId: room.id, station: view.goal, focus: view.lookAt, evidenceTick: lastObserved }),
      action,
      cited: [],
    })];
  });
}

/** Run-wide fraction adequately person-searched; older beliefs without it fall back to fractionAdequate. */
function searchedFraction(entry: RoomCoverage | undefined): number {
  return entry === undefined ? 0 : entry.fractionSearched ?? entry.fractionAdequate;
}

/**
 * Rooms on the latest unknown evacuation routes whose fresh person-search fraction (after the intervention,
 * within the route evidence age) is below what route support needs. Rooms are found from the route's
 * waypoints and leg midpoints.
 */
function staleRouteRooms(ctx: Ctx, coverage: ReadonlyMap<RoomId, RoomCoverage>): Set<RoomId> {
  const since = Math.max(ctx.now - ROUTE_EVIDENCE_MAX_AGE_TICKS, (ctx.lastInterventionTick ?? -1) + 1);
  const rooms = new Set<RoomId>();
  for (const route of latestRoutes(ctx.belief.routes)) {
    if (route.purpose !== "evacuation" || route.status !== "unknown") continue;
    const points = route.waypoints.flatMap((p, i) => (i === 0 ? [p] : [scale(add(route.waypoints[i - 1], p), 0.5), p]));
    for (const p of points) {
      const room = roomContaining(ctx.prior, p);
      if (room === null || rooms.has(room.id)) continue;
      const entry = coverage.get(room.id);
      if (entry === undefined || searchedFractionSince(entry, since) < ROUTE_MIN_FRESH_SEARCHED_FRACTION) rooms.add(room.id);
    }
  }
  return rooms;
}

/**
 * Inside the room when the aircraft is inside or an observed open entry exists, else from outside. From
 * outside, an interior viewpoint the drone has no passable way to yet falls back to an exterior one, and the
 * set's notes say so (or that the room is not offered when it has no exterior opening to look through).
 */
function roomViewpoint(ctx: Ctx, room: PriorRoom, notes: Note[]): Viewpoint | null {
  const interior = roomInteriorPoint(room);
  if (interior === null) return null;
  if (!ctx.outside || ctx.openEntries.length > 0) {
    if (!insideEnvelope(ctx, interior)) return null;
    const blocked = unreachableInside(ctx, interior);
    if (blocked === null) return interiorViewpoint(ctx, room, interior, notes);
    const outside = exteriorViewpoint(ctx, room, interior);
    const roomName = roomLabel(room);
    notes.push(outside === null
      ? { candidateId: null, text: `Not offering to inspect ${roomName}: the drone has no passable way into it from outside yet (${blocked}).` }
      : { candidateId: candidateId("inspect_room", room.id), text: `Inspecting ${roomName} from outside only: the drone has no passable way into it yet (${blocked}).` });
    return outside;
  }
  return exteriorViewpoint(ctx, room, interior);
}

/**
 * Why a station inside a room is withheld while the aircraft is outside: the route assessor finds no
 * drone-passable way to it (openings last observed open or broken, or unobserved ones the plan draws open;
 * never a closed door or an unbroken window). Null when the station is outside, the aircraft is inside or
 * cannot be placed clear of the walls to route from, or a way exists (fire on it does not withhold the
 * station: steering weighs fire, and the runtime's flight-path filter remains a second check).
 */
function unreachableInside(ctx: Ctx, station: Vec3): string | null {
  if (!ctx.outside || ctx.start === null || roomContaining(ctx.prior, station) === null) return null;
  const route = assessRoute(
    { belief: ctx.belief, tick: ctx.now, lastInterventionTick: ctx.lastInterventionTick, policy: ctx.policy },
    { id: "reach-inside", purpose: "return", from: ctx.start, destination: { kind: "point", point: station }, traveler: "drone", speedMps: ctx.speedMps },
  );
  if (route.waypoints.length > 0) return null;
  const impassable = /impassable openings: (.*)\.$/.exec(route.reason)?.[1];
  return impassable === undefined ? "the floor-plan prior connects no exterior opening to it" : `impassable: ${impassable}`;
}

/**
 * The interior viewpoint of a room the aircraft can reach. With a possible occupant on that floor it must keep
 * the person clearance and have clearance-keeping access in and back out (as a second look must); else the
 * room is looked into from beyond one of its doorways; else it is not offered, and the set says so.
 */
function interiorViewpoint(ctx: Ctx, room: PriorRoom, interior: Vec3, notes: Note[]): Viewpoint | null {
  const via = ctx.outside ? `by entering through ${entryLabel(ctx, room)}` : "from inside the room";
  if (!ctx.occupants.some(o => Math.abs(o.position.z - interior.z) <= PERSON_SAME_FLOOR_M)) return { goal: interior, lookAt: interior, via };
  if (occupantTooClose(ctx, interior) === null && accessClear(ctx, ctx.pose, interior) && exitClear(ctx, interior, room)) return { goal: interior, lookAt: interior, via };
  for (const door of roomDoors(ctx, room)) {
    const c = door.opening.center;
    for (const depthM of DOORWAY_VIEW_DEPTHS_M) {
      const goal = round3(vec3(c.x + door.out.x * depthM, c.y + door.out.y * depthM, (door.other.zMin + door.other.zMax) / 2));
      if (stationClear(ctx, goal, door.other) && sightThroughOpening(goal, interior, door.opening, door.out, door.along) && accessClear(ctx, ctx.pose, goal)) {
        return { goal, lookAt: interior, via: `from beyond ${door.opening.kind} ${label(door.opening.id)}, keeping clear of a possible occupant` };
      }
    }
  }
  notes.push({ candidateId: null, text: `Not offering to inspect ${roomLabel(room)}: a possible occupant leaves no station inside with clearance-keeping access in and out, and no doorway view of it.` });
  return null;
}

/** Outside with no observed open entry: look in from the nearest exterior opening of the room (the incumbent's, if it is one). */
function exteriorViewpoint(ctx: Ctx, room: PriorRoom, interior: Vec3): Viewpoint | null {
  const kept = incumbentStation(ctx, candidateId("inspect_room", room.id));
  let best: Viewpoint | null = null;
  let bestM = Infinity;
  for (const opening of ctx.prior.openings) {
    const normal = horizontalUnit(opening.outwardNormal);
    if (opening.rooms[0] !== room.id || opening.rooms[1] !== "exterior" || normal === null) continue;
    const goal = round3(add(opening.center, scale(normal, EXTERIOR_VIEW_DISTANCE_M)));
    const metres = kept !== null && distance(kept, goal) < 1e-6 ? -1 : distance(ctx.pose, goal);
    if (metres < bestM && insideEnvelope(ctx, goal)) {
      best = { goal, lookAt: interior, via: `from outside ${opening.kind} ${label(opening.id)}` };
      bestM = metres;
    }
  }
  return best;
}

function entryLabel(ctx: Ctx, room: PriorRoom): string {
  const own = ctx.openEntries.find(opening => opening.rooms[0] === room.id);
  const entry = own ?? nearestOpening(ctx, ctx.openEntries);
  if (entry === null) return "opening";
  const state = ctx.latestOpening.get(entry.id)?.state ?? "open";
  return `${entry.kind} ${label(entry.id)} (observed ${state})`;
}

function nearestOpening(ctx: Ctx, openings: readonly PriorOpening[]): PriorOpening | null {
  let best: PriorOpening | null = null;
  for (const opening of openings) {
    if (best === null || distance(ctx.pose, opening.center) < distance(ctx.pose, best.center)) best = opening;
  }
  return best;
}

function inspectAction(ctx: Ctx, view: Viewpoint): ActionSpec {
  const arrived = horizontalDistance(ctx.pose, view.goal) <= ctx.policy.arrivalToleranceM && Math.abs(ctx.pose.z - view.goal.z) <= VERTICAL_ARRIVAL_M;
  return arrived ? { kind: "scan", lookAt: view.lookAt, durationTicks: SCAN_TICKS } : moveTo(ctx, view.goal);
}

/* investigate_signal: a second viewpoint of a possible-occupant track. */

function investigateCandidates(ctx: Ctx, notes: Note[]): ProposalCandidate[] {
  return ctx.belief.tracks.flatMap(track => {
    // A guided person is walking out: a stand-clear look watches them instead (after-guidance section).
    if (track.status !== "possible" || ctx.guidedIds.has(track.id)) return [];
    const room = track.roomId === null ? null : ctx.rooms.get(track.roomId) ?? null;
    const goal = secondViewpoint(ctx, track, room);
    const where = room === null ? "" : ` in ${roomLabel(room)}`;
    if (goal === null) {
      notes.push({ candidateId: null, text: `Not offering a second look at possible-occupant track ${label(track.id)}${where}: no viewpoint from the doorway or in the room keeps ${fmt(personStandoffM(ctx, track.uncertaintyM))} m from the lead and ${fmt(stationWallClearance(ctx))} m from the walls with clearance-keeping access in and back out to the room's exit.` });
      return [];
    }
    if (!keepsReserve(ctx, travelS(ctx, goal))) return [];
    const inPlace = horizontalDistance(goal, ctx.pose) <= ctx.policy.arrivalToleranceM && Math.abs(goal.z - ctx.pose.z) <= VERTICAL_ARRIVAL_M;
    const action: ActionSpec = inPlace ? { kind: "scan", lookAt: round3(track.position), durationTicks: SCAN_TICKS } : moveTo(ctx, goal);
    const blocked = unreachableInside(ctx, goal);
    if (blocked !== null) {
      notes.push({ candidateId: null, text: `Not offering a second look at possible-occupant track ${label(track.id)}${where}: its viewpoint is inside, and the drone has no passable way in from outside yet (${blocked}).` });
      return [];
    }
    const description = `${inPlace ? "From here, take a second look at" : "Move to a second viewpoint of"} possible-occupant track ${label(track.id)}${where} (confidence ${fmt(track.confidence)}, last seen ${ageText(ctx, track.lastSeenTick)} ago).`;
    return [build(ctx, {
      id: candidateId("investigate_signal", track.id),
      tool: "investigate_signal",
      description,
      rationale: `${description} The viewpoint keeps ${fmt(horizontalDistance(goal, track.position))} m from the lead (at least ${fmt(personStandoffM(ctx, track.uncertaintyM))} m) and ${fmt(stationWallClearance(ctx))} m from the walls, ${room !== null && pointInPolygon(goal.x, goal.y, room.polygon) ? "with clearance-keeping access to it and back out to the room's exit" : "looking in from beyond the doorway"}. A second view tests the lead; a detection is not a confirmed person.`,
      target: target({ roomId: track.roomId, trackId: track.id, station: goal, focus: track.position, evidenceTick: track.lastSeenTick }),
      action,
      cited: cite(ctx, track.observationIds),
    })];
  });
}

/** The incumbent second viewpoint while it is still valid and not yet reached, else null. */
function keptSecondViewpoint(ctx: Ctx, track: OccupantTrack, room: PriorRoom | null): Vec3 | null {
  const kept = incumbentStation(ctx, candidateId("investigate_signal", track.id));
  if (kept === null) return null;
  // Once the aircraft is there, the second view has been taken: no move to where it already is.
  const arrived = horizontalDistance(ctx.pose, kept) <= ctx.policy.arrivalToleranceM && Math.abs(ctx.pose.z - kept.z) <= VERTICAL_ARRIVAL_M;
  if (arrived) return null;
  const inRoom = room === null || pointInPolygon(kept.x, kept.y, room.polygon);
  if (inRoom) {
    const near = horizontalDistance(kept, track.position) <= Math.max(MAX_KEPT_VIEW_M, personStandoffM(ctx, track.uncertaintyM) + 0.5);
    return near && stationClear(ctx, kept, room) && accessClear(ctx, ctx.pose, kept) && (room === null || exitClear(ctx, kept, room)) ? kept : null;
  }
  // A doorway view: still beyond a passable door of the lead's room and looking at the lead through it.
  const door = roomDoors(ctx, room).find(d => pointInPolygon(kept.x, kept.y, d.other.polygon) && sightThroughOpening(kept, track.position, d.opening, d.out, d.along));
  return door !== undefined && stationClear(ctx, kept, door.other) && accessClear(ctx, ctx.pose, kept) ? kept : null;
}

/** Inside the envelope, clear of the walls of its room by wallClearanceM + span/2, clear of every possible occupant, and not avoided. */
function stationClear(ctx: Ctx, p: Vec3, room: PriorRoom | null): boolean {
  if (room !== null && !pointInPolygon(p.x, p.y, room.polygon)) return false;
  return insideEnvelope(ctx, p) && wallDistance(wallPolygons(ctx, room, p.z), p) >= stationWallClearance(ctx) && occupantTooClose(ctx, p) === null && !avoided(ctx, p);
}

/** Clearance an aircraft keeps from every wall without range assistance: the wall band plus half its span. */
function stationWallClearance(ctx: Ctx): number {
  return ctx.policy.wallClearanceM + ctx.profile.spanM / 2;
}

/**
 * How far an aircraft station stays from a possible occupant: the harness's required distance (half the span,
 * the policy's person clearance, or guidance clearance for a guide, and the occupant's uncertainty) plus
 * PERSON_STATION_MARGIN_M.
 */
function personStandoffM(ctx: Ctx, uncertaintyM: number, kind: "move" | "guide" = "move"): number {
  return requiredPersonDistanceM(ctx.harness, uncertaintyM, personClearanceFor(ctx.harness, kind)) + PERSON_STATION_MARGIN_M;
}

/**
 * The first possible occupant (a track or a fresh detection: a detection may sit apart from the track it feeds)
 * a station at `p` would be too close to, measured horizontally on the same floor (stricter than H18's
 * Euclidean distance), or null.
 */
function occupantTooClose(ctx: Ctx, p: Vec3, kind: "move" | "guide" = "move"): PossibleOccupant | null {
  return ctx.occupants.find(o => Math.abs(o.position.z - p.z) <= PERSON_SAME_FLOOR_M && horizontalDistance(o.position, p) < personStandoffM(ctx, o.uncertaintyM, kind)) ?? null;
}

/**
 * A clearance-keeping way from `from` to `to`: the route graph's drone path (the plan's passable openings),
 * every point of which either keeps each possible occupant's required distance or is no nearer than `from`
 * (backing away from someone who came near stays possible, as in H18). With no path at all it is clear only
 * from outside, where reachability is judged and explained separately (unreachableInside).
 */
function accessClear(ctx: Ctx, from: Vec3, to: Vec3): boolean {
  const near = ctx.occupants.filter(o => Math.abs(o.position.z - to.z) <= PERSON_SAME_FLOOR_M || Math.abs(o.position.z - from.z) <= PERSON_SAME_FLOOR_M);
  if (near.length === 0) return true;
  const points = dronePath(ctx, from, to);
  if (points === null) return ctx.outside && from === ctx.pose;
  return near.every(o => {
    const requiredM = requiredPersonDistanceM(ctx.harness, o.uncertaintyM, personClearanceFor(ctx.harness, "move"));
    const startM = horizontalDistance(from, o.position);
    return everySample(points, q => {
      const dM = horizontalDistance(q, o.position);
      return !(dM < requiredM && dM < startM - 1e-6);
    });
  });
}

/** The route graph's drone path from `from` to `to` (memoized for the set), from and to included; null when there is none. */
function dronePath(ctx: Ctx, from: Vec3, to: Vec3): readonly Vec3[] | null {
  const key = `${from.x},${from.y},${from.z}>${to.x},${to.y},${to.z}`;
  const known = ctx.paths.get(key);
  if (known !== undefined) return known;
  const route = assessRoute(
    { belief: ctx.belief, tick: ctx.now, lastInterventionTick: ctx.lastInterventionTick, policy: ctx.policy },
    { id: "station-access", purpose: "return", from, destination: { kind: "point", point: to }, traveler: "drone", speedMps: ctx.speedMps },
  );
  const path = route.waypoints.length === 0 ? null : [from, ...route.waypoints, to];
  ctx.paths.set(key, path);
  return path;
}

/** Whether `test` holds at every `stepM` along the polyline, in order. */
function everySample(points: readonly Vec3[], test: (q: Vec3) => boolean, stepM = ACCESS_SAMPLE_STEP_M): boolean {
  if (points.length === 1) return test(points[0]);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const steps = Math.max(1, Math.ceil(distance(a, b) / stepM));
    for (let k = i === 1 ? 0 : 1; k <= steps; k++) {
      if (!test(vec3(a.x + ((b.x - a.x) * k) / steps, a.y + ((b.y - a.y) * k) / steps, a.z + ((b.z - a.z) * k) / steps))) return false;
    }
  }
  return true;
}

/** A clearance-keeping way from a station inside `room` back out through one of its drone-passable openings. */
function exitClear(ctx: Ctx, p: Vec3, room: PriorRoom): boolean {
  return roomExits(ctx, room).some(exit => accessClear(ctx, p, exit));
}

/** Approach points just beyond each opening of the room the drone can pass (observed state first, else the plan's). */
function roomExits(ctx: Ctx, room: PriorRoom): Vec3[] {
  return ctx.prior.openings.flatMap(opening => {
    const normal = horizontalUnit(opening.outwardNormal);
    if (!opening.rooms.includes(room.id) || normal === null) return [];
    if (!passableFor("drone", opening, ctx.latestOpening.get(opening.id)?.state ?? opening.priorState)) return [];
    const ahead = add(opening.center, scale(normal, EXIT_APPROACH_M));
    const behind = add(opening.center, scale(normal, -EXIT_APPROACH_M));
    return [pointInPolygon(ahead.x, ahead.y, room.polygon) ? behind : ahead];
  });
}

/** Farthest the incumbent second viewpoint may be from the lead before a new one is chosen. */
const MAX_KEPT_VIEW_M = MAX_SECOND_VIEW_M + 0.5;

/**
 * A second viewpoint of the lead. From beyond a doorway first: a station in a neighbouring room, through a
 * drone-passable opening of the lead's room, whose sight line to the lead passes the door; it never enters
 * the occupant's room. Else inside the room, around the lead and rotated away from the current line of
 * sight, only with clearance-keeping access to it and back out to one of the room's exits. Every station
 * keeps the person clearance (policy personClearanceM from the aircraft's edge, plus half its span, the
 * occupant's uncertainty and PERSON_STATION_MARGIN_M) from every possible occupant, tracks and fresh
 * detections alike, and wallClearanceM + span/2 from the walls (the prior shows no furniture). The incumbent
 * viewpoint is kept while it stays valid and the aircraft has not reached it.
 */
function secondViewpoint(ctx: Ctx, track: OccupantTrack, room: PriorRoom | null): Vec3 | null {
  const kept = keptSecondViewpoint(ctx, track, room);
  if (kept !== null) return kept;
  return (room === null ? null : doorwayViewpoint(ctx, track, room)) ?? inRoomViewpoint(ctx, track, room);
}

/**
 * A station beyond one of the room's drone-passable interior openings, looking at the lead through it. When the
 * aircraft already stands at such a station, that is where the second look is taken (a scan in place).
 */
function doorwayViewpoint(ctx: Ctx, track: OccupantTrack, room: PriorRoom): Vec3 | null {
  const doors = roomDoors(ctx, room);
  const here = round3(ctx.pose);
  if (doors.some(d => stationClear(ctx, here, d.other) && sightThroughOpening(here, track.position, d.opening, d.out, d.along))) return here;
  for (const door of doors) {
    const z = (door.other.zMin + door.other.zMax) / 2;
    for (const depthM of DOORWAY_VIEW_DEPTHS_M) {
      for (const offsetM of DOORWAY_VIEW_OFFSETS_M) {
        const c = door.opening.center;
        const goal = round3(vec3(c.x + door.out.x * depthM + door.along.x * offsetM, c.y + door.out.y * depthM + door.along.y * offsetM, z));
        // The doorway view is itself the second look: a short move onto a valid one is fine (no MIN_NEW_VIEW_M).
        if (!stationClear(ctx, goal, door.other) || !sightThroughOpening(goal, track.position, door.opening, door.out, door.along)) continue;
        if (accessClear(ctx, ctx.pose, goal) && ctx.reachable(goal)) return goal;
      }
    }
  }
  return null;
}

interface Doorway {
  readonly opening: PriorOpening;
  /** The neighbouring room the doorway leads into. */
  readonly other: PriorRoom;
  /** Unit horizontal vector out of the room through the opening, and along its wall. */
  readonly out: Vec3;
  readonly along: Vec3;
}

/** The room's drone-passable openings into neighbouring prior rooms. */
function roomDoors(ctx: Ctx, room: PriorRoom): Doorway[] {
  return ctx.prior.openings.flatMap(opening => {
    const normal = horizontalUnit(opening.outwardNormal);
    const otherId = opening.rooms[0] === room.id ? opening.rooms[1] : opening.rooms[1] === room.id ? opening.rooms[0] : null;
    const other = otherId === null ? undefined : ctx.rooms.get(otherId);
    if (normal === null || other === undefined || !passableFor("drone", opening, ctx.latestOpening.get(opening.id)?.state ?? opening.priorState)) return [];
    const out = pointInPolygon(opening.center.x + normal.x * EXIT_APPROACH_M, opening.center.y + normal.y * EXIT_APPROACH_M, room.polygon) ? scale(normal, -1) : normal;
    return [{ opening, other, out, along: vec3(-out.y, out.x, 0) }];
  });
}

/** The horizontal sight line from `from` (beyond the opening) to `to` (in the room) crosses the opening's plane between its jambs. */
function sightThroughOpening(from: Vec3, to: Vec3, opening: PriorOpening, out: Vec3, along: Vec3): boolean {
  const a = dot(sub(from, opening.center), out);
  const b = dot(sub(to, opening.center), out);
  if (!(a > 0) || !(b < 0)) return false;
  const q = add(from, scale(sub(to, from), a / (a - b)));
  return Math.abs(dot(sub(q, opening.center), along)) <= opening.widthM / 2 - DOOR_SIGHT_MARGIN_M;
}

/** A station in the lead's room around it, with clearance-keeping access in and back out (see secondViewpoint). */
function inRoomViewpoint(ctx: Ctx, track: OccupantTrack, room: PriorRoom | null): Vec3 | null {
  const p = track.position;
  const bearing = horizontalDistance(ctx.pose, p) > 1e-6 ? Math.atan2(ctx.pose.y - p.y, ctx.pose.x - p.x) : 0;
  const nearestM = Math.max(personStandoffM(ctx, track.uncertaintyM), Math.min(MAX_SECOND_VIEW_M, track.uncertaintyM + SECOND_VIEW_STANDOFF_M));
  const z = room === null ? ctx.pose.z : (room.zMin + room.zMax) / 2;
  for (const extraM of SECOND_VIEW_EXTRA_RADII_M) {
    for (const angle of SECOND_VIEW_ANGLES_RAD) {
      const radiusM = nearestM + extraM;
      const goal = round3(vec3(p.x + radiusM * Math.cos(bearing + angle), p.y + radiusM * Math.sin(bearing + angle), z));
      if (horizontalDistance(goal, ctx.pose) < MIN_NEW_VIEW_M || !stationClear(ctx, goal, room)) continue;
      if (accessClear(ctx, ctx.pose, goal) && (room === null || exitClear(ctx, goal, room)) && ctx.reachable(goal)) return goal;
    }
  }
  return null;
}

function avoided(ctx: Ctx, p: Vec3): boolean {
  return ctx.avoid.some(a => distance(a.point, p) <= a.radiusM);
}

/*
 * request_breach: a closed exterior window, observed recently, when no observed opening serves the room.
 *
 * A window is never offered when a possible occupant is within its uncertainty plus the harness person margin
 * of the debris region the harness itself derives (effects.ts affectedRegion/breachRegion): H6 refuses that
 * breach anyway. Every offered window carries a BreachAccess assessment that the local planner scores:
 *   - access toward the rescue: the cheapest drone-passable way (route assessor rules: observed open or broken
 *     openings, or unobserved openings the plan draws open; one per opening, STAIR_HOPS per stair) from the
 *     window's room to the fire's room, a possible occupant's room or a reported room. A room whose interior
 *     openings are all impassable to the drone (closed doors it cannot open) would strand it; a room holding a
 *     possible occupant is kept free of glass while another entry serves;
 *   - an exterior approach: a route over the floor-plan prior from the aircraft to the point in front of the
 *     window that never enters a room;
 *   - visibility: the share of the samples H6 needs searched (harness coverage.ts requiredSamples) that the
 *     aircraft's person-search cameras see from the standoff while facing the pane at its height, through the
 *     pane (both faces of the wall) for samples behind it (only RGB sees through intact glass), and whether
 *     that share reaches the harness's breach coverage floor (policy.breachMinCoverageFraction). It is an
 *     estimate from the plan: on Troy it reads 15-30 points above what the aircraft's real camera footprints
 *     cover, so it ranks windows and names likely shortfalls but never replaces H6;
 *   - the fit of the aircraft through the pane; a pane leaving less than half the obstacle clearance on each
 *     side is too tight to enter with a margin.
 */

/** Openings a stair is worth when counting the way from a window's room toward the rescue: a floor change is a long, smoky transit. */
export const STAIR_HOPS = 3;
/** BreachAccess.occupiedBy for a room a report names (no track yet): it ranks like an occupied room. */
const REPORTED_ROOM = "reported";
/** The exterior approach is checked to this point on the window's outward normal. */
const APPROACH_OUT_M = 1.0;
/** An aircraft position closer than this to a wall (beyond the policy's wall band) is moved out before routing from it. */
const START_PUSH_M = 0.1;

/** The access assessment (types.ts BreachAccess) a request_breach candidate carries; null for any other candidate. */
export function breachAccessOf(candidate: MissionCandidate): BreachAccess | null {
  return candidate.tool === "request_breach" ? (candidate.target?.access ?? null) : null;
}

/** Where a strike on a window would be made from and what its debris could reach. */
interface BreachGeometry {
  readonly strike: Vec3;
  readonly standoff: Vec3;
  readonly action: BreachSpec;
  /** The harness's own affected region for this action (effects.ts). */
  readonly region: Region;
}

/** A breach of a window whose closed state was observed recently enough to cite. */
interface BreachPlan extends BreachGeometry {
  readonly evidence: OpeningEvidence;
}

interface Link {
  readonly room: RoomId;
  readonly via: string;
  readonly cost: number;
  readonly passable: boolean;
}

/** Shared by every window of one set. */
interface AccessContext {
  readonly links: ReadonlyMap<RoomId, readonly Link[]>;
  /** Rooms that matter for the rescue and why; empty when nothing is known. */
  readonly targets: ReadonlyMap<RoomId, string>;
  /** Rooms holding a possible occupant (lowest track id first). */
  readonly occupied: ReadonlyMap<RoomId, TrackId>;
  /** For H6's sample set, on the coarser VISIBILITY_SPACING_M grid. */
  readonly harness: HarnessContext;
  readonly cameras: readonly SensorSpec[];
  readonly cameraKey: string;
}

function breachCandidates(ctx: Ctx, notes: Note[]): ProposalCandidate[] {
  const breaker = ctx.profile.modules.glassBreaker;
  if (breaker === null || !ctx.outside) return [];
  let shared: AccessContext | null = null;
  const sharedContext = (): AccessContext => (shared ??= accessContext(ctx));
  // Looks are observation moves: they stay on offer while the pose is not yet good enough for an intervention (a fast
  // exterior transit), so the move toward the entry window is not dropped and resumed as the estimate varies.
  const poseSupported = interventionPoseSupported(ctx);
  const breaches = ctx.prior.openings.flatMap(opening => {
    const plan = poseSupported ? breachPlan(ctx, opening, breaker) : null;
    if (plan === null) return [];
    const roomName = roomNameOf(ctx, opening.rooms[0]);
    const blocking = occupantNear(ctx, plan.region);
    if (blocking !== null) {
      notes.push({ candidateId: null, text: `No breach of window ${label(opening.id)} into ${roomName}: ${blocking.what} (±${fmt(blocking.uncertaintyM)} m) is ${fmt(blocking.distanceM)} m from its glass-debris region, inside its uncertainty plus the ${fmt(ctx.policy.personMarginM)} m person margin; the harness refuses glass into an occupied space.` });
      return [];
    }
    const access = breachAccess(ctx, sharedContext(), opening, plan);
    const id = candidateId("request_breach", opening.id);
    for (const text of accessNotes(ctx, opening, roomName, access)) notes.push({ candidateId: id, text });
    const description = `Request commander approval to break window ${label(opening.id)} into ${roomName} (observed closed ${ageText(ctx, plan.evidence.tick)} ago; ${accessPhrase(ctx, access)}). Nothing breaks before individual approval.`;
    const candidate = build(ctx, {
      id,
      tool: "request_breach",
      description,
      rationale: `${description} No open entry into this room has been observed. Glass debris may reach ${fmt(breaker.debrisRadiusM)} m inward and falls to the floor and the ground below; a broken window stays broken. ${accessSentences(ctx, roomName, access)}`,
      target: target({ roomId: opening.rooms[0], openingId: opening.id, station: plan.standoff, focus: plan.strike, evidenceTick: plan.evidence.tick, access }),
      action: plan.action,
      cited: [plan.evidence.observationId],
    });
    return [candidate];
  });
  coverageNote(ctx, breaches, notes);
  return [...breaches, ...sizeUpLooks(ctx, sharedContext, breaker, breaches, notes)];
}

/** Says which offered windows a look from the standoff is expected to leave short of the harness's breach coverage floor. */
function coverageNote(ctx: Ctx, breaches: readonly ProposalCandidate[], notes: Note[]): void {
  const floor = ctx.policy.breachMinCoverageFraction;
  const short = breaches.flatMap(c => {
    const access = breachAccessOf(c);
    return access !== null && !access.clearsCoverage ? [`${label(c.target.openingId ?? c.id)} (about ${Math.round(access.visibleFraction * 100)}%)`] : [];
  }).sort(compareText);
  if (short.length === 0) return;
  const all = short.length === breaches.length;
  notes.push({ candidateId: null, text: `${all ? "No offered window is" : `${short.length} of ${breaches.length} offered windows are not`} expected to show the ${Math.round(floor * 100)}% of its debris region the harness needs searched for a breach from its standoff: ${short.slice(0, 6).join(", ")}${short.length > 6 ? " and more" : ""}; the harness refuses such a breach for coverage until a recent person search has covered more of it.` });
}

/*
 * The 360° size-up. When access is needed (outside, no observed open entry) and a breach is on offer, every
 * exterior window not yet observed (or observed too long ago to cite) gets the same access assessment. A
 * window whose access, discounted for being unconfirmed (access-score.ts), beats every observed breach is
 * worth a look before glass is broken: at most MAX_LOOKS such looks are offered, one per room (its best
 * window), each an observation-only inspect_room move to SIZE_UP_VIEW_DISTANCE_M in front of the pane,
 * facing it. The local planner ranks them above the best breach. Once the window is observed closed, its
 * breach candidate replaces the look. The runtime cools a look once it starts (planner-step.ts), so each
 * window gets one look per cooling period; a cooled look is not offered and the next window may be.
 */
const MAX_LOOKS = 2;
/** A look at a window is taken from this far in front of the pane, at its height. */
const SIZE_UP_VIEW_DISTANCE_M = EXTERIOR_VIEW_DISTANCE_M;

interface LookOption {
  readonly opening: PriorOpening;
  readonly access: BreachAccess;
  readonly score: number;
  readonly view: Viewpoint;
  readonly id: string;
}

function sizeUpLooks(ctx: Ctx, sharedContext: () => AccessContext, breaker: GlassBreakerSpec, breaches: readonly ProposalCandidate[], notes: Note[]): ProposalCandidate[] {
  // Demo: also before any window has been seen, so the first move goes straight to the best-placed window (its look ends
  // on the breach standoff and the breach is proposed there) instead of first inspecting rooms from outside.
  // No look after a strike: the way in is the pane just broken (its next frames show it), not another window.
  if (ctx.openEntries.length > 0 || ctx.lastInterventionTick !== null) return [];
  // A breach left out of this set (cooling after a refusal) is no alternative to a look.
  const scored = breaches.filter(c => !ctx.omitted.has(c.id)).map(c => ({ candidate: c, score: breachAccessScore(breachAccessOf(c) as BreachAccess) })).sort((a, b) => b.score - a.score || compareText(a.candidate.id, b.candidate.id));
  const best = scored.length > 0 ? scored[0] : null;
  // With every observed breach cooling, a look still has to promise positive access.
  const bestScore = best?.score ?? 0;
  const roomsWithBreach = new Set(breaches.map(c => c.target.roomId));
  const options = ctx.prior.openings.flatMap(opening => {
    // A window seen closed whose breach is not on offer yet (the pose does not support an intervention) keeps its look.
    if (!(awaitingLook(ctx, opening) || seenClosed(ctx, opening)) || roomsWithBreach.has(opening.rooms[0])) return [];
    const option = lookOption(ctx, sharedContext, breaker, opening);
    return option !== null && option.score > bestScore ? [option] : [];
  });
  // Equal access: the window the aircraft reaches sooner along its exterior route (not in a straight line through the house).
  const routeS = new Map(options.map(option => [option.id, approachDurationS(ctx, option.opening)]));
  const soonest = (option: LookOption) => routeS.get(option.id) ?? Infinity;
  options.sort((a, b) => b.score - a.score || soonest(a) - soonest(b) || distance(ctx.pose, a.view.goal) - distance(ctx.pose, b.view.goal) || compareText(a.id, b.id));
  const rooms = new Set<RoomId>();
  // Glass stays out of a reported or occupied room while a window into another room is worth a look.
  const elsewhere = options.some(option => option.access.occupiedBy === null);
  const chosen = options.filter(option => (!elsewhere || option.access.occupiedBy === null)).filter(option => {
    if (rooms.has(option.opening.rooms[0]) || rooms.size >= MAX_LOOKS) return false;
    rooms.add(option.opening.rooms[0]);
    return true;
  });
  return chosen.flatMap(option => {
    const look = lookCandidate(ctx, option, best);
    if (look === null) return [];
    const against = best === null ? "every observed window is cooling after a refusal" : `unconfirmed, its access still scores ${fmt(option.score)} against ${fmt(best.score)} for window ${label(best.candidate.target.openingId ?? best.candidate.id)}`;
    notes.push({ candidateId: look.id, text: `Size-up: look at window ${label(option.opening.id)} of ${roomNameOf(ctx, option.opening.rooms[0])} before choosing where to break in: ${against}.` });
    return [look];
  });
}

/**
 * A look at a window taken from its breach standoff, facing the pane: arriving there is the look, and the breach
 * (offered once the pane is seen closed) is proposed from where the aircraft already is. Null when the window has no
 * viewpoint or breach geometry, the look is left out of this set, or a possible occupant is near its debris region.
 */
function lookOption(ctx: Ctx, sharedContext: () => AccessContext, breaker: GlassBreakerSpec, opening: PriorOpening): LookOption | null {
  const id = candidateId("inspect_room", opening.rooms[0], opening.id);
  const geometry = ctx.omitted.has(id) || windowViewpoint(ctx, opening) === null ? null : breachGeometry(ctx, opening, breaker);
  if (geometry === null || occupantNear(ctx, geometry.region) !== null) return null;
  const view: Viewpoint = { goal: geometry.standoff, lookAt: geometry.strike, via: `from the breach standoff of window ${label(opening.id)}` };
  const access = breachAccess(ctx, sharedContext(), opening, geometry);
  return { opening, access, score: unconfirmedAccessScore(access), view, id };
}

/** Estimated flight time along the exterior route to the point APPROACH_OUT_M in front of the window; Infinity without one. */
function approachDurationS(ctx: Ctx, opening: PriorOpening): number {
  const normal = horizontalUnit(opening.outwardNormal);
  if (ctx.start === null || normal === null) return Infinity;
  const point = add(opening.center, scale(normal, APPROACH_OUT_M));
  const route = assessRoute(
    { belief: ctx.belief, tick: ctx.now, lastInterventionTick: ctx.lastInterventionTick, policy: ctx.policy },
    { id: `look-approach-${opening.id}`, purpose: "return", from: ctx.start, destination: { kind: "point", point }, traveler: "drone", speedMps: ctx.speedMps },
  );
  return route.status === "unsupported" || route.waypoints.length === 0 ? Infinity : route.estimatedDurationS;
}

/** An exterior window last seen closed, recently enough to cite. */
function seenClosed(ctx: Ctx, opening: PriorOpening): boolean {
  if (opening.kind !== "window" || opening.rooms[1] !== "exterior" || !ctx.rooms.has(opening.rooms[0])) return false;
  const evidence = ctx.latestOpening.get(opening.id);
  return evidence !== undefined && evidence.state === "closed" && evidence.tick >= freshFrom(ctx) && ctx.citable.has(evidence.observationId);
}

/** An exterior window whose state has not been observed recently enough to cite (and not last seen blocked). */
function awaitingLook(ctx: Ctx, opening: PriorOpening): boolean {
  if (opening.kind !== "window" || opening.rooms[1] !== "exterior" || !ctx.rooms.has(opening.rooms[0]) || horizontalUnit(opening.outwardNormal) === null) return false;
  const evidence = ctx.latestOpening.get(opening.id);
  if (evidence === undefined) return true;
  if (evidence.state === "blocked") return false;
  return evidence.tick < freshFrom(ctx) || !ctx.citable.has(evidence.observationId);
}

/** In front of the pane at its height, clear of the walls and inside the envelope, facing the pane. */
function windowViewpoint(ctx: Ctx, opening: PriorOpening): Viewpoint | null {
  const normal = horizontalUnit(opening.outwardNormal);
  if (normal === null) return null;
  const goal = round3(add(opening.center, scale(normal, SIZE_UP_VIEW_DISTANCE_M)));
  if (!insideEnvelope(ctx, goal) || !clearOfRooms(ctx.prior, [goal.x, goal.y], ctx.policy.wallClearanceM)) return null;
  return { goal, lookAt: round3(opening.center), via: `from in front of window ${label(opening.id)}` };
}

function lookCandidate(ctx: Ctx, option: LookOption, best: { readonly candidate: ProposalCandidate; readonly score: number } | null): ProposalCandidate | null {
  const { opening, access, view } = option;
  const action = inspectAction(ctx, view);
  const durationS = action.kind === "scan" ? action.durationTicks * TICK_S : travelS(ctx, view.goal);
  if (!keepsReserve(ctx, durationS)) return null;
  const roomName = roomNameOf(ctx, opening.rooms[0]);
  const connected = !access.closedIn && access.hopsToTarget !== null && access.targetRoomId !== null;
  const bestWindow = best === null ? null : label(best.candidate.target.openingId ?? best.candidate.id);
  const why = connected
    ? `it opens into a room connected toward the target (${accessPhrase(ctx, access)})`
    : bestWindow === null ? "every observed window is cooling after a refusal" : `its access may beat window ${bestWindow}'s`;
  const comparison = best === null || bestWindow === null
    ? "No observed window is currently on offer."
    : `Counted at ${Math.round(UNCONFIRMED_ACCESS_FACTOR * 100)}% until seen, its access (${fmt(option.score)}) still beats breaking window ${bestWindow} (${fmt(best.score)}).`;
  const description = `Look at window ${label(opening.id)} of ${roomName} before choosing where to break in: ${why}. Observation only.`;
  const evidence = ctx.latestOpening.get(opening.id);
  const seen = evidence === undefined ? "Its state has not been observed." : `Its state was last observed ${ageText(ctx, evidence.tick)} ago, too long to rely on.`;
  return build(ctx, {
    id: option.id,
    tool: "inspect_room",
    description,
    rationale: `Look at ${label(opening.id)} before choosing where to break in: ${why}. ${seen} ${comparison} Once it is observed closed, breaking it becomes a candidate. A look does not mark the room empty. ${accessSentences(ctx, roomName, access)}`,
    target: target({ roomId: opening.rooms[0], openingId: opening.id, station: view.goal, focus: view.lookAt, evidenceTick: evidence?.tick ?? null, access }),
    action,
    cited: [],
  });
}

/** A size-up look at a window (an inspect_room candidate aimed at a window, carrying its unconfirmed access). */
export function isWindowLook(candidate: MissionCandidate): boolean {
  return candidate.tool === "inspect_room" && candidate.target !== null && candidate.target.openingId !== null && candidate.target.access !== null;
}

function breachPlan(ctx: Ctx, opening: PriorOpening, breaker: GlassBreakerSpec): BreachPlan | null {
  const evidence = ctx.latestOpening.get(opening.id);
  if (evidence === undefined || evidence.state !== "closed" || evidence.tick < freshFrom(ctx) || !ctx.citable.has(evidence.observationId)) return null;
  // A strike or spray since the window was last seen closed may have changed it: the plan made the tick a breach
  // completes still saw the struck pane closed (its next frames show it broken) and offered the same breach again,
  // which then waited for the commander. Look at the window again first.
  if (ctx.lastInterventionTick !== null && evidence.tick <= ctx.lastInterventionTick) return null;
  // Prefer an observed opening: no breach into a room that already has an observed open entry.
  if (ctx.openEntries.some(entry => entry.rooms[0] === opening.rooms[0])) return null;
  const geometry = breachGeometry(ctx, opening, breaker);
  return geometry === null ? null : { ...geometry, evidence };
}

function breachGeometry(ctx: Ctx, opening: PriorOpening, breaker: GlassBreakerSpec): BreachGeometry | null {
  const normal = horizontalUnit(opening.outwardNormal);
  if (opening.kind !== "window" || opening.rooms[1] !== "exterior" || normal === null) return null;
  const strike = round3(opening.center);
  const standoff = round3(add(opening.center, scale(normal, breaker.reachM * BREACH_REACH_FRACTION)));
  if (!insideEnvelope(ctx, standoff) || !keepsReserve(ctx, breaker.strikeDelayTicks * TICK_S)) return null;
  const action: BreachSpec = { kind: "breach_opening", openingId: opening.id, standoff, strikePoint: strike };
  const region = affectedRegion(action, ctx.profile, ctx.prior);
  return region === null ? null : { strike, standoff, action, region };
}

function accessContext(ctx: Ctx): AccessContext {
  const occupied = new Map<RoomId, TrackId>();
  for (const track of possibleTracks(ctx)) {
    const roomId = trackRoomId(ctx, track);
    if (roomId !== null && !occupied.has(roomId)) occupied.set(roomId, track.id);
  }
  const reasons = new Map<RoomId, string[]>();
  const add = (roomId: RoomId, reason: string) => {
    const list = reasons.get(roomId) ?? [];
    if (!list.includes(reason)) list.push(reason);
    reasons.set(roomId, list);
  };
  // A fire water is unsafe for is no reason to go in: the aircraft could not suppress it (request_suppression section).
  for (const fire of latestFires(ctx)) if (fire.room !== null && fireClassOf(ctx, fire).waterSuitable) add(fire.room.id, "fire");
  for (const roomId of occupied.keys()) add(roomId, "possible occupant");
  for (const roomId of [...ctx.reportedRooms].sort(compareText)) if (ctx.rooms.has(roomId)) add(roomId, "reported");
  const cameras = ctx.profile.sensors.filter(isSearchCamera);
  // The harness memoizes samples per region object; the regions sampled here are this factory's own, so the
  // coarser grid never mixes with the samples H6 itself draws for a submitted proposal.
  const samplingPolicy: HarnessPolicy = { ...ctx.policy, coverageSpacingM: Math.max(ctx.policy.coverageSpacingM, VISIBILITY_SPACING_M) };
  return {
    links: roomLinks(ctx),
    targets: new Map([...reasons].map(([roomId, list]) => [roomId, list.join(" and ")])),
    occupied,
    harness: { tick: ctx.now, missionStartTick: ctx.envelope.approvedTick, profile: ctx.profile, policy: samplingPolicy, envelope: ctx.envelope, belief: ctx.belief },
    cameras,
    cameraKey: JSON.stringify(cameras.map(c => [c.id, c.modality, c.mount.positionBody, c.mount.yawRad, c.mount.pitchRad, c.horizontalFovDeg, c.verticalFovDeg])),
  };
}

function breachAccess(ctx: Ctx, shared: AccessContext, opening: PriorOpening, plan: BreachGeometry): BreachAccess {
  const roomId = opening.rooms[0];
  const links = shared.links.get(roomId) ?? [];
  const closedIn = !links.some(link => link.passable);
  const targets = shared.targets.size > 0 ? shared.targets : new Map(ctx.prior.rooms.filter(room => room.id !== roomId).map(room => [room.id, "the rest of the house"] as const));
  const way = nearestTarget(shared.links, roomId, targets);
  const minSide = Math.min(opening.widthM, opening.heightM);
  const clearance = 2 * ctx.profile.hardLimits.minObstacleClearanceM;
  const visible = visibleFraction(ctx, shared, opening, plan);
  return {
    hopsToTarget: way?.hops ?? null,
    targetRoomId: way?.roomId ?? null,
    targetReason: way === null ? null : (targets.get(way.roomId) ?? null),
    via: way?.via ?? [],
    closedIn,
    closedOpeningIds: links.filter(link => !link.passable).map(link => link.via),
    occupiedBy: occupantOf(ctx, shared, roomId),
    approach: ctx.start === null ? null : exteriorApproach(ctx, opening, ctx.start),
    visibleFraction: visible,
    clearsCoverage: visible >= ctx.policy.breachMinCoverageFraction,
    apertureFit: roundTo(clearance > 0 ? clamp01((minSide - ctx.profile.spanM) / clearance) : minSide > ctx.profile.spanM ? 1 : 0, 1000),
  };
}

/**
 * Demo: a room a report names counts like an occupied one (glass kept out while another entry serves), so the first
 * entry is not the window whose debris would reach the reported person once they are seen.
 */
function occupantOf(ctx: Ctx, shared: AccessContext, roomId: RoomId): TrackId | null {
  return shared.occupied.get(roomId) ?? (ctx.reportedRooms.has(roomId) ? REPORTED_ROOM : null);
}

/** Interior openings (route-assessor drone passability) and stairs between prior rooms, both ways. */
function roomLinks(ctx: Ctx): Map<RoomId, Link[]> {
  const links = new Map<RoomId, Link[]>();
  const push = (from: RoomId, link: Link) => links.set(from, [...(links.get(from) ?? []), link]);
  for (const opening of ctx.prior.openings) {
    const [a, b] = opening.rooms;
    // The route graph ignores openings with no horizontal normal (a stairwell void); stairs carry floor changes.
    if (a === "exterior" || b === "exterior" || !ctx.rooms.has(a) || !ctx.rooms.has(b) || horizontalUnit(opening.outwardNormal) === null) continue;
    const passable = passableFor("drone", opening, ctx.latestOpening.get(opening.id)?.state ?? opening.priorState);
    push(a, { room: b, via: opening.id, cost: 1, passable });
    push(b, { room: a, via: opening.id, cost: 1, passable });
  }
  for (const stair of ctx.prior.stairs ?? []) {
    if (!ctx.rooms.has(stair.bottomRoomId) || !ctx.rooms.has(stair.topRoomId)) continue;
    push(stair.bottomRoomId, { room: stair.topRoomId, via: stair.id, cost: STAIR_HOPS, passable: true });
    push(stair.topRoomId, { room: stair.bottomRoomId, via: stair.id, cost: STAIR_HOPS, passable: true });
  }
  return links;
}

interface Way {
  readonly hops: number;
  readonly via: readonly string[];
}

/** Cheapest passable way from a room to any target room (Dijkstra over rooms; ties by room id). */
function nearestTarget(links: ReadonlyMap<RoomId, readonly Link[]>, from: RoomId, targets: ReadonlyMap<RoomId, string>): (Way & { readonly roomId: RoomId }) | null {
  const best = new Map<RoomId, Way>([[from, { hops: 0, via: [] }]]);
  const done = new Set<RoomId>();
  for (let room: RoomId | null = from; room !== null; room = nextRoom(best, done)) {
    const reached = best.get(room) ?? { hops: 0, via: [] };
    if (targets.has(room)) return { ...reached, roomId: room };
    done.add(room);
    for (const link of links.get(room) ?? []) {
      const known = best.get(link.room);
      const hops = reached.hops + link.cost;
      if (link.passable && !done.has(link.room) && (known === undefined || hops < known.hops)) best.set(link.room, { hops, via: [...reached.via, link.via] });
    }
  }
  return null;
}

/** The unsettled room with the fewest hops, then the smallest id. */
function nextRoom(best: ReadonlyMap<RoomId, Way>, done: ReadonlySet<RoomId>): RoomId | null {
  let pick: RoomId | null = null;
  let pickHops = Infinity;
  for (const [id, way] of best) {
    if (done.has(id) || way.hops > pickHops || (way.hops === pickHops && pick !== null && compareText(id, pick) >= 0)) continue;
    pick = id;
    pickHops = way.hops;
  }
  return pick;
}

/**
 * The aircraft's position for routing, moved out of the wall band when it hovers right at a facade (as it
 * does docked at a pane) so the route assessor places it outside; null when it cannot be placed clear.
 */
function exteriorStart(pose: Vec3, prior: FloorPlanPrior, policy: HarnessPolicy): Vec3 | null {
  const at: Point2 = [pose.x, pose.y];
  const want = policy.wallClearanceM + START_PUSH_M;
  let nearest: { readonly polygon: readonly Point2[]; readonly d: number } | null = null;
  for (const room of prior.rooms) {
    if (room.polygon.length < 3) continue;
    if (insidePolygon(at, room.polygon)) return null;
    const d = pointBoundaryDistance(at, room.polygon);
    if (nearest === null || d < nearest.d) nearest = { polygon: room.polygon, d };
  }
  if (nearest === null || nearest.d >= want) return pose;
  const edge = nearestBoundaryPoint(at, nearest.polygon);
  const out = direction2(edge, at);
  if (out === null) return null;
  const moved: Point2 = [edge[0] + out[0] * want, edge[1] + out[1] * want];
  return clearOfRooms(prior, moved, policy.wallClearanceM) ? vec3(moved[0], moved[1], pose.z) : null;
}

/** An exterior route from the aircraft to the point APPROACH_OUT_M in front of the window that never enters a room. */
function exteriorApproach(ctx: Ctx, opening: PriorOpening, start: Vec3): boolean {
  const normal = horizontalUnit(opening.outwardNormal);
  if (normal === null) return false;
  const point = add(opening.center, scale(normal, APPROACH_OUT_M));
  if (!clearOfRooms(ctx.prior, [point.x, point.y], ctx.policy.wallClearanceM)) return false;
  const route = assessRoute(
    { belief: ctx.belief, tick: ctx.now, lastInterventionTick: ctx.lastInterventionTick, policy: ctx.policy },
    { id: `breach-approach-${opening.id}`, purpose: "return", from: start, destination: { kind: "point", point }, traveler: "drone", speedMps: ctx.speedMps },
  );
  return route.status !== "unsupported" && route.waypoints.length > 0 && route.waypoints.every(p => ctx.prior.rooms.every(room => !insidePolygon([p.x, p.y], room.polygon)));
}

function clearOfRooms(prior: FloorPlanPrior, p: Point2, clearanceM: number): boolean {
  return prior.rooms.every(room => room.polygon.length < 3 || (!insidePolygon(p, room.polygon) && pointBoundaryDistance(p, room.polygon) >= clearanceM));
}

/**
 * Visibility is an estimate for ranking, not a coverage check: H6's sample set is drawn on a grid of at least
 * this spacing (the harness uses policy.coverageSpacingM, 0.25 m by default; on the Troy windows the coarser
 * grid moves the fraction by a few percent and costs an eighth as much).
 */
const VISIBILITY_SPACING_M = 0.5;
/** Openings within this distance of the debris region's bounds can change which of its samples the debris reaches. */
const VISIBILITY_OPENING_REACH_M = 1.0;
const MAX_CACHED_VISIBILITY = 512;
/** Per prior: visibility by window, standoff, aircraft cameras, policy and the states of nearby openings. */
const visibilityCache = new WeakMap<FloorPlanPrior, Map<string, number>>();

/**
 * Share of the samples H6 needs searched for this breach (occupiable, reachable by the debris, plus the edge
 * band) that a person-search camera sees from the standoff with the aircraft facing the strike point: inside
 * the camera's field of view and, for a sample behind the pane's plane, on a sight line through the pane
 * (RGB only: thermal does not see through intact glass). Walls beyond the pane are not traced; H6's own
 * reachability from the strike point already drops samples behind them. 0 when there is nothing to see with.
 * Memoized, since the samples are costly and the inputs rarely change between plans.
 */
function visibleFraction(ctx: Ctx, shared: AccessContext, opening: PriorOpening, plan: BreachGeometry): number {
  const key = visibilityKey(ctx, shared, opening, plan);
  let byPrior = visibilityCache.get(ctx.prior);
  if (byPrior === undefined) {
    byPrior = new Map();
    visibilityCache.set(ctx.prior, byPrior);
  }
  const cached = byPrior.get(key);
  if (cached !== undefined) return cached;
  const value = computeVisibleFraction(shared, opening, plan, wallHalfDepth(ctx, opening));
  if (byPrior.size >= MAX_CACHED_VISIBILITY) byPrior.clear();
  byPrior.set(key, value);
  return value;
}

/** Everything the estimate depends on: the H6 samples move only with nearby openings last observed closed or blocked. */
function visibilityKey(ctx: Ctx, shared: AccessContext, opening: PriorOpening, plan: BreachGeometry): string {
  const b = regionBounds(plan.region);
  const reach = ctx.policy.coverageMarginM + VISIBILITY_OPENING_REACH_M;
  const nearby = ctx.prior.openings.filter(o => o.center.x >= b.min.x - reach && o.center.x <= b.max.x + reach && o.center.y >= b.min.y - reach && o.center.y <= b.max.y + reach && o.center.z >= b.min.z - reach && o.center.z <= b.max.z + reach);
  const shut = nearby.filter(o => {
    const state = ctx.latestOpening.get(o.id)?.state;
    return state === "closed" || state === "blocked";
  }).map(o => o.id).sort(compareText);
  const p = (v: Vec3) => `${v.x},${v.y},${v.z}`;
  return [opening.id, p(plan.standoff), p(plan.strike), ctx.profile.modules.glassBreaker?.debrisRadiusM ?? 0, shared.cameraKey, ctx.policy.coverageMarginM, ctx.policy.wallClearanceM, Math.max(ctx.policy.coverageSpacingM, VISIBILITY_SPACING_M), shut.join(",")].join("|");
}

function computeVisibleFraction(shared: AccessContext, opening: PriorOpening, plan: BreachGeometry, halfDepthM: number): number {
  const outward = horizontalUnit(opening.outwardNormal);
  if (outward === null || shared.cameras.length === 0) return 0;
  const { points } = requiredSamples(plan.region, shared.harness, [opening.id], true, plan.standoff);
  if (points.length === 0) return 0;
  const pose: Pose = { position: plan.standoff, yawRad: yawBetween(plan.standoff, plan.strike) };
  const tangent = vec3(-outward.y, outward.x, 0);
  let seen = 0;
  for (const p of points) {
    const behindPane = dot(sub(p, opening.center), outward) < 0;
    const visible = shared.cameras.some(camera => {
      if (behindPane && camera.modality !== "rgb") return false;
      const origin = bodyPointToWorld(pose, camera.mount.positionBody);
      return cameraSees(pose.yawRad, camera, origin, p) && (!behindPane || throughPane(origin, p, opening, outward, tangent, halfDepthM));
    });
    if (visible) seen += 1;
  }
  return roundTo(seen / points.length, 1000);
}

function isSearchCamera(sensor: SensorSpec): boolean {
  return (sensor.modality === "rgb" || sensor.modality === "thermal") && (sensor.horizontalFovDeg ?? 0) > 0 && (sensor.verticalFovDeg ?? 0) > 0;
}

/** Inside the camera's field of view (azimuth about its axis within half the horizontal FOV, elevation within half the vertical). */
function cameraSees(yawRad: number, camera: SensorSpec, origin: Vec3, p: Vec3): boolean {
  const r = rotateWorldToBody(yawRad + camera.mount.yawRad, sub(p, origin));
  const c = Math.cos(camera.mount.pitchRad);
  const s = Math.sin(camera.mount.pitchRad);
  const forward = c * r.x - s * r.z;
  if (!(forward > 1e-9)) return false;
  const up = s * r.x + c * r.z;
  const halfH = ((camera.horizontalFovDeg ?? 0) * Math.PI) / 360;
  const halfV = ((camera.verticalFovDeg ?? 0) * Math.PI) / 360;
  return Math.abs(Math.atan2(r.y, forward)) <= halfH && Math.abs(Math.atan2(up, Math.hypot(forward, r.y))) <= halfV;
}

/** The sight line from a camera outside the pane's plane to a point behind it crosses the plane within the pane. */
/**
 * The sight line from a camera outside the wall to a point behind the pane passes the opening at both faces
 * of the wall (centre ± halfDepthM along the normal), so the reveal of a thick wall clips oblique views
 * through a small pane.
 */
function throughPane(origin: Vec3, p: Vec3, opening: PriorOpening, outward: Vec3, tangent: Vec3, halfDepthM: number): boolean {
  const a = dot(sub(origin, opening.center), outward);
  const b = dot(sub(p, opening.center), outward);
  if (!(b < 0)) return false;
  for (const face of [halfDepthM, 0, -halfDepthM]) {
    if (!(a > face)) return false;
    if (!(b < face)) continue;
    const d = sub(add(origin, scale(sub(p, origin), (a - face) / (a - b))), opening.center);
    if (Math.abs(dot(d, tangent)) > opening.widthM / 2 || Math.abs(d.z) > opening.heightM / 2) return false;
  }
  return true;
}

/** Most a wall's half-thickness is taken to be, whatever the plan says. */
const MAX_WALL_HALF_DEPTH_M = 0.3;

/** Half the wall's thickness at an exterior opening: the plan puts the opening's centre mid-wall, its room polygon at the inner face. */
function wallHalfDepth(ctx: Ctx, opening: PriorOpening): number {
  const room = ctx.rooms.get(opening.rooms[0]);
  if (room === undefined || room.polygon.length < 3) return 0;
  return Math.min(MAX_WALL_HALF_DEPTH_M, pointBoundaryDistance([opening.center.x, opening.center.y], room.polygon));
}

function possibleTracks(ctx: Ctx): OccupantTrack[] {
  return ctx.belief.tracks.filter(track => track.status === "possible" && track.confidence >= ctx.policy.personConfidenceThreshold).sort((a, b) => compareText(a.id, b.id));
}

function trackRoomId(ctx: Ctx, track: OccupantTrack): RoomId | null {
  if (track.roomId !== null && ctx.rooms.has(track.roomId)) return track.roomId;
  return roomContaining(ctx.prior, track.position)?.id ?? null;
}

/** Short phrase for the description: where entering through this window leads (the rationale says why). */
function accessPhrase(ctx: Ctx, access: BreachAccess): string {
  const parts: string[] = [];
  if (access.occupiedBy === REPORTED_ROOM) parts.push("a report names this room");
  else if (access.occupiedBy !== null) parts.push(`possible occupant ${label(access.occupiedBy)} inside`);
  else if (access.closedIn) parts.push(access.closedOpeningIds.length > 0 ? "only closed doors lead on" : "no interior opening leads on");
  else if (access.hopsToTarget === null || access.targetRoomId === null) parts.push("no open way on");
  else if (access.hopsToTarget === 0) parts.push(`the ${access.targetReason ?? "target"} room`);
  else parts.push(`leads to ${roomNameOf(ctx, access.targetRoomId)}`);
  if (access.approach === false) parts.push("no exterior approach");
  if (access.apertureFit < TIGHT_FIT) parts.push("a tight pane");
  return parts.join("; ");
}

/** Plain sentences for the rationale. */
function accessSentences(ctx: Ctx, roomName: string, access: BreachAccess): string {
  const out: string[] = [];
  if (access.occupiedBy === REPORTED_ROOM) out.push(`A report names ${roomName}; glass is kept out of it while another entry serves.`);
  else if (access.occupiedBy !== null) out.push(`Possible occupant ${label(access.occupiedBy)} is in ${roomName}; glass is kept out of an occupied room while another entry serves.`);
  if (access.closedIn) out.push(closedInSentence(roomName, access));
  else if (access.hopsToTarget === 0) out.push(`${roomName} is the ${access.targetReason ?? "target"} room.`);
  else if (access.hopsToTarget !== null && access.targetRoomId !== null) out.push(`${roomName} leads to ${roomNameOf(ctx, access.targetRoomId)} (${access.targetReason ?? "target"}) through ${access.via.map(label).join(", ")}.`);
  else out.push(`No drone-passable way leads from ${roomName} toward the fire, a possible occupant or a reported room.`);
  if (access.approach === false) out.push("No exterior approach to the window was found in the floor-plan prior.");
  out.push(`About ${Math.round(access.visibleFraction * 100)}% of the debris region H6 needs searched is in view from the standoff.`);
  return out.join(" ");
}

function closedInSentence(roomName: string, access: BreachAccess): string {
  if (access.closedOpeningIds.length === 0) return `${roomName} has no interior opening, so entering there would strand the aircraft.`;
  return `${roomName} opens onto the rest of the house only through ${access.closedOpeningIds.map(label).join(", ")}, which the drone cannot pass (it cannot open doors), so entering there would strand it.`;
}

/** Set-level notes for a window that ranks low. */
function accessNotes(ctx: Ctx, opening: PriorOpening, roomName: string, access: BreachAccess): string[] {
  const window = `Window ${label(opening.id)} into ${roomName} ranks low:`;
  const notes: string[] = [];
  if (access.closedIn) notes.push(`${window} ${closedInSentence(roomName, access)}`);
  if (access.occupiedBy === REPORTED_ROOM) notes.push(`${window} a report names that room; glass is kept out of it while another entry serves.`);
  else if (access.occupiedBy !== null) notes.push(`${window} possible occupant ${label(access.occupiedBy)} is in that room; glass is kept out of an occupied room while another entry serves.`);
  if (access.approach === false) notes.push(`${window} no exterior approach to it was found in the floor-plan prior.`);
  if (access.apertureFit < TIGHT_FIT) notes.push(`${window} its ${fmt(Math.min(opening.widthM, opening.heightM))} m pane leaves the ${fmt(ctx.profile.spanM)} m aircraft less than half its obstacle clearance on each side.`);
  return notes;
}

function roomNameOf(ctx: Ctx, roomId: RoomId): string {
  const room = ctx.rooms.get(roomId);
  return room === undefined ? label(roomId) : roomLabel(room);
}

/*
 * request_suppression: a bounded water jet toward an observed fire, within the module's limits.
 *
 * Water is this aircraft's only agent. A fire the evidence indicates water is unsafe for (evidence/fire-class.ts:
 * a cooking-oil, fuel or live electrical cue in a report, a kitchen, garage or utility room in or near it in the
 * prior, a crew statement) gets no spray candidate, with a note naming the evidence; the harness refuses such a
 * spray anyway (H19), so it is never offered, and the route sweep and the homeward return do not wait for it
 * (awaitingSuppression). After a spray reaches a fire, no further spray is offered there until a sighting captured
 * after that spray still shows flame (harness respray.ts; H14 refuses it otherwise). Meanwhile a look at the fire
 * from the spray's standoff is offered (fireRecheckCandidate), and for POST_SPRAY_LOOK_TICKS after the spray no
 * other observation move is: the aircraft holds facing the fire until it is seen out or still burning.
 */

/** Right after a spray, other observation moves wait this long for the look at the sprayed fire (15 s). */
const POST_SPRAY_LOOK_TICKS = 1500;
const RECHECK_SUFFIX = "fire-recheck";

interface FireTarget {
  readonly hazard: HazardEvidence;
  readonly room: PriorRoom | null;
}

interface SprayPlan {
  readonly aim: Vec3;
  readonly standoff: Vec3;
  readonly flowLps: number;
  readonly durationTicks: number;
  /** Estimated share of the jet's H6 samples the aircraft's cameras see from the standoff, facing the aim. */
  readonly visibleShare: number;
}

function suppressionCandidates(ctx: Ctx, notes: Note[]): ProposalCandidate[] {
  const water = ctx.profile.modules.water;
  if (water === null || !interventionPoseSupported(ctx)) return [];
  const flowLps = sprayFlowLps(ctx, water);
  const durationTicks = sprayDurationTicks(ctx, flowLps);
  if (durationTicks === null || !keepsReserve(ctx, durationTicks * TICK_S)) return [];
  return latestFires(ctx).flatMap(fire => {
    const where = fire.room === null ? "" : ` in ${roomLabel(fire.room)}`;
    const agent = fireClassOf(ctx, fire);
    if (!agent.waterSuitable) {
      notes.push({ candidateId: null, text: `Suppression is not available for the fire${where}: ${agent.summary} Water is the only agent carried; route assessment and guidance continue without spraying.` });
      return [];
    }
    const sprayed = sprayAfterSighting(ctx.sprays, fire.hazard, water);
    if (sprayed !== null) {
      const ended = sprayed.endedTick === null ? "is still discharging" : `ended ${ageText(ctx, sprayed.endedTick)} ago`;
      notes.push({ candidateId: null, text: `Not offering another spray at the fire${where} yet: spray proposal ${sprayed.proposalId}, which reached it, ${ended}, and no sighting since shows whether it still burns. The aircraft looks at it first.` });
      return [];
    }
    const plan = sprayPlan(ctx, fire, water, flowLps, durationTicks);
    if (plan === null) {
      notes.push({ candidateId: null, text: `No spray standoff for the fire${fire.room === null ? "" : ` in ${roomLabel(fire.room)}`}: no point ${sprayReaches(water).map(fmt).join(", ")} m from it${fire.room === null ? "" : " in its room"} keeps the aircraft ${fmt(sprayWallClearance(ctx))} m from every wall with a jet line clear of walls and corners, outside the fire's ${fmt(FIRE_CLEARANCE_M + FIRE_CLEARANCE_MARGIN_M)} m clearance and away from any possible occupant.` });
      return [];
    }
    const blocked = unreachableInside(ctx, plan.standoff);
    if (blocked !== null) {
      notes.push({ candidateId: null, text: `Not offering suppression of the fire${fire.room === null ? "" : ` in ${roomLabel(fire.room)}`}: its standoff is inside, and the drone has no passable way in from outside yet (${blocked}).` });
      return [];
    }
    const candidate = suppressionCandidate(ctx, fire, plan);
    // The jet may reach another fire place than the one aimed at: the harness assesses every place it reaches.
    const reached = candidate.proposal.action.kind === "spray" ? sprayFireClass(candidate.proposal.action, ctx.harness).assessment : agent;
    if (!reached.waterSuitable) {
      notes.push({ candidateId: null, text: `Suppression is not available for the fire${where}: the jet would reach a place where ${reached.summary}` });
      return [];
    }
    return [candidate];
  });
}

/** The fire-class assessment of a fire's latest sighting (evidence/fire-class.ts), computed once per set. */
function fireClassOf(ctx: Ctx, fire: FireTarget): FireClassAssessment {
  const known = ctx.fireClasses.get(fire.hazard);
  if (known !== undefined) return known;
  const assessment = assessFireClass(ctx.belief, fire.hazard.region);
  ctx.fireClasses.set(fire.hazard, assessment);
  return assessment;
}

/**
 * A fire still to be suppressed: seen burning and not one water is unsafe for. The route sweep and the homeward
 * return wait only for these; with the aircraft's only agent ruled out, waiting would never end.
 */
function awaitingSuppression(ctx: Ctx): boolean {
  return latestFires(ctx).some(fire => fireClassOf(ctx, fire).waterSuitable);
}

interface SprayedFire {
  readonly fire: FireTarget;
  readonly spray: SprayDischarge;
}

/** Fires (water-suitable) whose latest sighting predates the end of a spray that reached them: they are looked at before any further spray. */
function sprayedFires(ctx: Ctx): SprayedFire[] {
  const water = ctx.profile.modules.water;
  if (water === null) return [];
  return latestFires(ctx).flatMap(fire => {
    const spray = fireClassOf(ctx, fire).waterSuitable ? sprayAfterSighting(ctx.sprays, fire.hazard, water) : null;
    return spray === null ? [] : [{ fire, spray }];
  });
}

/** The spray ended within POST_SPRAY_LOOK_TICKS (or still runs): the look at its fire comes before any other look. */
function recheckUrgent(ctx: Ctx, spray: SprayDischarge): boolean {
  return spray.endedTick === null || ctx.now - spray.endedTick <= POST_SPRAY_LOOK_TICKS;
}

/** A sprayed-fire look (see the section comment). */
export function isFireRecheck(candidate: MissionCandidate): boolean {
  return candidate.tool === "inspect_room" && candidate.id.endsWith(`:${RECHECK_SUFFIX}`);
}

/**
 * Look at a sprayed fire from the spray's standoff, facing its aim point (the cameras saw the fire from there):
 * a scan in place when the aircraft is there or cannot fly there, else a move back to it.
 */
function fireRecheckCandidate(ctx: Ctx, { fire, spray }: SprayedFire): ProposalCandidate {
  const where = fire.room === null ? "" : ` in ${roomLabel(fire.room)}`;
  const aim = round3(spray.action.aimPoint);
  const standoff = round3(spray.action.standoff);
  const inPlace = atStation(ctx, standoff) || !ctx.reachable(standoff);
  const station = inPlace ? round3(ctx.pose) : standoff;
  const ended = spray.endedTick === null ? "is still discharging" : `ended ${ageText(ctx, spray.endedTick)} ago`;
  const description = `${inPlace ? "Hold and look at" : "Return to the spray standoff and look at"} the fire${where} again: spray proposal ${spray.proposalId}, which reached it, ${ended}, and no sighting since shows whether it still burns. Observation only.`;
  return build(ctx, {
    id: candidateId("inspect_room", fire.room?.id ?? "unassigned", RECHECK_SUFFIX),
    tool: "inspect_room",
    description,
    rationale: `${description} Another spray is offered only if a sighting captured after the spray still shows flame; a sighting with no flame lets the route reassessment begin.`,
    target: target({ roomId: fire.room?.id ?? null, station, focus: aim, evidenceTick: fire.hazard.tick }),
    action: inPlace ? { kind: "scan", lookAt: aim, durationTicks: SCAN_TICKS } : moveTo(ctx, standoff),
    cited: [],
  });
}

function suppressionCandidate(ctx: Ctx, fire: FireTarget, plan: SprayPlan): ProposalCandidate {
  const where = fire.room === null ? "" : ` in ${roomLabel(fire.room)}`;
  const doseL = plan.flowLps * plan.durationTicks * TICK_S;
  const description = `Request commander approval for a ${fmt(doseL)} L water jet at ${fmt(plan.flowLps)} L/s toward the fire observed${where} ${ageText(ctx, fire.hazard.tick)} ago, from ${fmt(distance(plan.standoff, plan.aim))} m. Nothing is sprayed before individual approval.`;
  return build(ctx, {
    id: sprayCandidateId(fire),
    tool: "request_suppression",
    description,
    rationale: `${description} The standoff keeps the aircraft at least ${fmt(sprayWallClearance(ctx))} m from every wall, so holding it needs no range assistance, and the jet line clear of walls and corners; about ${Math.round(plan.visibleShare * 100)}% of the jet's search region is in view from it (an estimate; H6 decides). The aircraft must hold the standoff to execute. Suppression alone does not make a route usable; fresh route evidence must follow.`,
    target: target({ roomId: fire.room?.id ?? null, station: plan.standoff, focus: plan.aim, evidenceTick: fire.hazard.tick }),
    action: { kind: "spray", standoff: plan.standoff, aimPoint: plan.aim, flowLps: plan.flowLps, durationTicks: plan.durationTicks },
    cited: [fire.hazard.observationId],
  });
}

/** Flow within the module maximum and the jet-reaction share of the current thrust margin (F = ρQ²/A). */
function sprayFlowLps(ctx: Ctx, water: WaterModuleSpec): number {
  const limits = ctx.profile.hardLimits;
  const allowedN = limits.maxReactionFractionOfMargin * (ctx.belief.aircraft.thrustAvailableN - limits.hoverThrustN);
  if (!(allowedN > 0)) return 0;
  const radiusM = water.nozzleDiameterMm / 2000;
  const reactionLimitedLps = Math.sqrt((allowedN * Math.PI * radiusM * radiusM) / WATER_DENSITY_KG_M3) * 1000;
  return Math.floor(Math.min(water.maxFlowLps, reactionLimitedLps) * 1000) / 1000;
}

/** Whole discharge ticks for the bounded dose, never more water than remains; null when none can be planned. */
function sprayDurationTicks(ctx: Ctx, flowLps: number): number | null {
  const remainingL = ctx.belief.aircraft.waterRemainingL;
  if (!(flowLps > 0) || remainingL === null || remainingL < MIN_SUPPRESSION_DOSE_L) return null;
  const doseL = Math.min(SUPPRESSION_DOSE_L, remainingL);
  let ticks = Math.min(MAX_DURATION_TICKS, Math.floor(doseL / (flowLps * TICK_S) + 1e-9));
  // The harness computes the dose as flow × ticks × TICK_S; keep that product within the remaining water.
  while (ticks > 0 && flowLps * ticks * TICK_S > remainingL) ticks -= 1;
  return ticks >= 1 ? ticks : null;
}

/** The latest fresh fire observation per room, skipped when it is no longer burning or cannot be cited. */
function latestFires(ctx: Ctx): FireTarget[] {
  const latest = new Map<string, FireTarget>();
  for (const hazard of ctx.belief.hazards) {
    if (hazard.hazard !== "fire" || hazard.tick < freshFrom(ctx)) continue;
    const room = fireRoom(ctx.prior, representativePoint(hazard.region));
    const key = room?.id ?? "";
    const current = latest.get(key);
    if (current === undefined || hazard.tick >= current.hazard.tick) latest.set(key, { hazard, room });
  }
  return [...latest.values()].filter(fire => fire.hazard.intensity > 0 && ctx.citable.has(fire.hazard.observationId));
}

/** A fire seen this far below a room's floor (its base, sighted at the floor surface) still burns in that room. */
const FIRE_FLOOR_TOLERANCE_M = 0.3;

/**
 * The room a fire burns in. A fire sits on a floor, and its sighting is often at the floor surface itself, a few
 * millimetres either side of the plane after estimation and rounding; a strict test would leave such a fire in
 * no room, and its spray standoff would no longer be kept inside the fire's room (sprayStandoffSupported).
 */
function fireRoom(prior: FloorPlanPrior, point: Vec3): PriorRoom | null {
  return roomContaining(prior, point) ?? roomContaining(prior, vec3(point.x, point.y, point.z + FIRE_FLOOR_TOLERANCE_M));
}

/**
 * The spray standoff: searched at SPRAY_REACH_STEPS_M distances × SPRAY_STANDOFF_BEARINGS bearings around the
 * aim point, at standoffZ height. A standoff must be in the fire's room, within the jet's range, outside the
 * fire's clearance, at least sprayWallClearance from every wall (so holding it needs no range assistance),
 * with the standoff→aim line keeping the jet cone's radius plus JET_CLEARANCE_MARGIN_M from every wall and
 * corner, inside the envelope and with no possible occupant near the jet region. Among those whose expected
 * share of the jet's H6 samples in camera view is within SPRAY_SHARE_MARGIN of the best (an estimate that reads
 * high, so used only to rank), the shortest reach wins, then the one nearest the aircraft, then search order.
 * The incumbent (the standoff the aircraft is already going to or holding) is kept while it meets the same
 * constraints and no option is expected to show more than SPRAY_SHARE_MARGIN more.
 */
function sprayPlan(ctx: Ctx, fire: FireTarget, water: WaterModuleSpec, flowLps: number, durationTicks: number): SprayPlan | null {
  const aim = round3(representativePoint(fire.hazard.region));
  const z = standoffZ(aim, fire.room);
  const options: { readonly standoff: Vec3; readonly region: Region; readonly step: number; readonly order: number }[] = [];
  sprayReaches(water).forEach((reachM, step) => {
    for (let k = 0; k < SPRAY_STANDOFF_BEARINGS; k++) {
      const bearing = (2 * Math.PI * k) / SPRAY_STANDOFF_BEARINGS;
      const standoff = round3(vec3(aim.x + reachM * Math.cos(bearing), aim.y + reachM * Math.sin(bearing), z));
      const region = sprayStandoffRegion(ctx, fire, water, standoff, aim);
      if (region !== null) options.push({ standoff, region, step, order: step * SPRAY_STANDOFF_BEARINGS + k });
    }
  });
  const kept = incumbentStation(ctx, sprayCandidateId(fire));
  const keptRegion = kept === null ? null : sprayStandoffRegion(ctx, fire, water, kept, aim);
  if (options.length === 0 && keptRegion === null) return null;
  const scored = options.map(option => ({ ...option, share: sprayVisibleShare(ctx, option.standoff, aim, option.region), travelM: distance(ctx.pose, option.standoff) }));
  const bestShare = Math.max(-Infinity, ...scored.map(option => option.share));
  if (kept !== null && keptRegion !== null && ctx.reachable(kept)) {
    const keptShare = sprayVisibleShare(ctx, kept, aim, keptRegion);
    if (scored.length === 0 || keptShare >= bestShare - SPRAY_SHARE_MARGIN) return { aim, standoff: kept, flowLps, durationTicks, visibleShare: keptShare };
  }
  // Near-equal views first, shorter reach by search step (the later steps are nearer), then the rest by view;
  // the first one the aircraft can fly to is taken.
  const equal = (o: { readonly share: number }) => o.share >= bestShare - SPRAY_SHARE_MARGIN;
  const ranked = scored.slice().sort((a, b) => Number(equal(b)) - Number(equal(a)) || (equal(a) ? b.step - a.step : b.share - a.share) || a.travelM - b.travelM || a.order - b.order);
  const chosen = ranked.find(option => ctx.reachable(option.standoff));
  return chosen === undefined ? null : { aim, standoff: chosen.standoff, flowLps, durationTicks, visibleShare: chosen.share };
}

function sprayCandidateId(fire: FireTarget): string {
  return candidateId("request_suppression", fire.room === null ? "unassigned" : fire.room.id);
}

/** The incumbent station when it belongs to this candidate, else null. */
function incumbentStation(ctx: Ctx, id: string): Vec3 | null {
  return ctx.incumbent !== null && ctx.incumbent.candidateId === id ? ctx.incumbent.station : null;
}

/** Standoff distances searched, longest first. */
function sprayReaches(water: WaterModuleSpec): number[] {
  const longest = Math.min(water.rangeM * SPRAY_RANGE_FRACTION, MAX_SPRAY_STANDOFF_M);
  return SPRAY_REACH_STEPS_M.map(step => roundTo(longest - step, 1000)).filter(reachM => reachM >= MIN_AIM_DISTANCE_M);
}

/** Clearance a hovering aircraft keeps from every wall without range assistance: the wall band plus half its span. */
function sprayWallClearance(ctx: Ctx): number {
  return stationWallClearance(ctx);
}

/** The jet region (the harness's own derivation) when the standoff meets every constraint of sprayPlan; null otherwise. */
function sprayStandoffRegion(ctx: Ctx, fire: FireTarget, water: WaterModuleSpec, standoff: Vec3, aim: Vec3): Region | null {
  const reachM = distance(standoff, aim);
  if (reachM < MIN_AIM_DISTANCE_M || reachM > water.rangeM) return null;
  if (fire.room !== null && !pointInPolygon(standoff.x, standoff.y, fire.room.polygon)) return null;
  // Measured level with the fire (horizontally): steering keeps a no-fly disc around a burning fire.
  if (distanceToRegion(fire.hazard.region, vec3(standoff.x, standoff.y, aim.z)) < FIRE_CLEARANCE_M + FIRE_CLEARANCE_MARGIN_M || !insideEnvelope(ctx, standoff)) return null;
  const walls = wallPolygons(ctx, fire.room, standoff.z);
  if (wallDistance(walls, standoff) < sprayWallClearance(ctx) || !jetLineClear(walls, standoff, aim, water)) return null;
  if (occupantTooClose(ctx, standoff) !== null || avoided(ctx, standoff)) return null;
  // The sector reaches where the jet lands, not just the aim point.
  const jet = sprayRegion({ kind: "spray", standoff, aimPoint: aim, flowLps: water.maxFlowLps, durationTicks: 1 }, water, ctx.prior.floors);
  return jet !== null && !occupantNearRegion(ctx, jet) ? jet : null;
}

/** The fire room's polygon, or with no room every room at that height: the walls a standoff and its jet must keep clear of. */
function wallPolygons(ctx: Ctx, room: PriorRoom | null, z: number): (readonly Point2[])[] {
  const rooms = room !== null ? [room] : ctx.prior.rooms.filter(r => r.zMin <= z && z <= r.zMax);
  return rooms.filter(r => r.polygon.length >= 3).map(r => r.polygon);
}

function wallDistance(walls: readonly (readonly Point2[])[], p: { readonly x: number; readonly y: number }): number {
  return walls.reduce((best, polygon) => Math.min(best, pointBoundaryDistance([p.x, p.y], polygon)), Infinity);
}

/** Along the standoff→aim line (all but its last JET_END_SLACK_M), walls and corners stay beyond the cone's radius plus the margin. */
function jetLineClear(walls: readonly (readonly Point2[])[], standoff: Vec3, aim: Vec3, water: WaterModuleSpec): boolean {
  const lengthM = horizontalDistance(standoff, aim);
  const tanHalf = Math.tan((water.coneHalfAngleDeg * Math.PI) / 180);
  for (let s = 0; s <= lengthM - JET_END_SLACK_M + 1e-9; s += JET_SAMPLE_STEP_M) {
    const t = lengthM > 0 ? s / lengthM : 0;
    const p = { x: standoff.x + (aim.x - standoff.x) * t, y: standoff.y + (aim.y - standoff.y) * t };
    if (wallDistance(walls, p) < s * tanHalf + JET_CLEARANCE_MARGIN_M) return false;
  }
  return true;
}

/**
 * Share of the jet's H6 samples (harness requiredSamples on the policy's own grid: occupiable, reachable from
 * the nozzle, not behind it) inside the field of view of a person-search camera, with the aircraft at the
 * standoff facing the aim. Walls are not traced (H6's reachability from the nozzle drops samples behind them);
 * the real camera footprints cover less, so this only ranks standoffs.
 */
function sprayVisibleShare(ctx: Ctx, standoff: Vec3, aim: Vec3, region: Region): number {
  const harness: HarnessContext = { tick: ctx.now, missionStartTick: ctx.envelope.approvedTick, profile: ctx.profile, policy: ctx.policy, envelope: ctx.envelope, belief: ctx.belief };
  const { points } = requiredSamples(region, harness, [], false);
  const cameras = ctx.profile.sensors.filter(isSearchCamera);
  if (points.length === 0 || cameras.length === 0) return 0;
  const pose: Pose = { position: standoff, yawRad: yawBetween(standoff, aim) };
  const origins = cameras.map(camera => bodyPointToWorld(pose, camera.mount.positionBody));
  const seen = points.filter(p => cameras.some((camera, i) => cameraSees(pose.yawRad, camera, origins[i], p))).length;
  return roundTo(seen / points.length, 1000);
}

function standoffZ(aim: Vec3, room: PriorRoom | null): number {
  const z = aim.z + SPRAY_STANDOFF_RISE_M;
  return room === null ? z : Math.min(Math.max(z, room.zMin + 0.5), room.zMax - 0.3);
}

/*
 * Post-suppression route reassessment: an ordered sweep of the evacuation route, in reverse route order, so the
 * route assessor finds every room and opening on it freshly observed at once (it needs each route room at least
 * ROUTE_MIN_FRESH_SEARCHED_FRACTION person-searched and each crossed opening observed, all after the last
 * intervention and within policy.routeEvidenceMaxAgeTicks). It runs while the aircraft is inside, a possible
 * occupant is tracked, the latest evacuation assessment is "unknown" and no fresh flame is seen. Steps:
 *   1. the room holding the exit, from a station facing the exit door;
 *   2. each room between, from where the route enters it on the exit side, looking along the route;
 *   3. the occupant's room, from a station in the room before it on the route, by the doorway, at least the
 *      guidance clearance (policy guidanceClearanceM + span/2 + uncertainty + margin) from the occupant,
 *      looking in. That station is ahead of the occupant on the route, within cue range, ready to guide.
 * The sweep keeps going forward (nextSweepStep): from the last step of the current pass, the next step whose
 * evidence is not fresh; an earlier step whose evidence expired meanwhile is swept again only after the last step,
 * since sweeping it first would let the later steps' evidence age in turn. The local planner ranks it above
 * second looks.
 */
const SWEEP_SUFFIX = "route-sweep";
/** Station distances from the exit door into the room, tried in order. */
const SWEEP_EXIT_VIEW_M = [2.0, 1.5, 2.5, 3.0];
/** Doorway station depths beyond the occupant's door, tried in order; offsets along the wall. */
const SWEEP_DOOR_DEPTHS_M = [1.4, 1.8, 2.2, 2.6, 1.0];
const SWEEP_DOOR_OFFSETS_M = [0, 0.4, -0.4];
/** Hover height above a room's floor at sweep stations. */
const SWEEP_HOVER_M = 1.4;
/** A sweep station's scan: shorter than an inspection's, since the route evidence must all stay fresh together. */
const SWEEP_SCAN_TICKS = 100;

interface SweepStep {
  readonly roomId: RoomId;
  readonly openingIds: readonly OpeningId[];
  readonly station: Vec3;
  readonly lookAt: Vec3;
  readonly what: string;
}

/** A route-sweep inspection (candidates.ts routeSweepCandidates). */
export function isRouteSweep(candidate: MissionCandidate): boolean {
  return candidate.tool === "inspect_room" && candidate.id.endsWith(`:${SWEEP_SUFFIX}`);
}

function routeSweepCandidates(ctx: Ctx): ProposalCandidate[] {
  if (ctx.outside || awaitingSuppression(ctx)) return [];
  // The sweep readies guidance; a person guidance has already run for is walking out (after-guidance section).
  const track = possibleTracks(ctx).filter(t => !ctx.guidedIds.has(t.id)).sort((a, b) => b.lastSeenTick - a.lastSeenTick || compareText(a.id, b.id))[0];
  const route = latestRoutes(ctx.belief.routes).find(r => r.purpose === "evacuation" && r.status === "unknown" && r.waypoints.length > 1);
  if (track === undefined || route === undefined) return [];
  const steps = sweepSteps(ctx, route, track);
  const since = Math.max(ctx.now - ctx.policy.routeEvidenceMaxAgeTicks, (ctx.lastInterventionTick ?? -1) + 1);
  const coverage = new Map(ctx.belief.coverage.map(entry => [entry.roomId, entry]));
  const pending = nextSweepStep(steps.map(step => stepDoneTick(ctx, step, coverage)), since, ctx.lastInterventionTick);
  if (pending < 0) return [];
  const step = steps[pending];
  const room = ctx.rooms.get(step.roomId);
  const view: Viewpoint = { goal: step.station, lookAt: step.lookAt, via: step.what };
  const arrived = horizontalDistance(ctx.pose, step.station) <= ctx.policy.arrivalToleranceM && Math.abs(ctx.pose.z - step.station.z) <= VERTICAL_ARRIVAL_M;
  const action: ActionSpec = arrived ? { kind: "scan", lookAt: step.lookAt, durationTicks: SWEEP_SCAN_TICKS } : moveTo(ctx, view.goal);
  const roomName = room === undefined ? label(step.roomId) : roomLabel(room);
  const description = `Reassess the evacuation route, step ${pending + 1} of ${steps.length} in reverse route order: ${arrived ? "scan" : "observe"} ${roomName} ${step.what}. Observation only; it does not mark the room empty.`;
  return [build(ctx, {
    id: candidateId("inspect_room", step.roomId, SWEEP_SUFFIX),
    tool: "inspect_room",
    description,
    rationale: `${description} The route needs each of its rooms person-searched and its doors observed within ${fmt(ctx.policy.routeEvidenceMaxAgeTicks * TICK_S)} s of one another; going from the exit back to the occupant ends the sweep by the occupant's doorway, ahead of them on the route.`,
    target: target({ roomId: step.roomId, station: step.station, focus: step.lookAt, evidenceTick: coverage.get(step.roomId)?.lastObservedTick ?? null }),
    action,
    cited: [],
  })];
}

/**
 * When a step's evidence was last complete: the latest tick since which its room has been at least
 * ROUTE_MIN_FRESH_SEARCHED_FRACTION person-searched and each of its openings observed; null when never.
 */
function stepDoneTick(ctx: Ctx, step: SweepStep, coverage: ReadonlyMap<RoomId, RoomCoverage>): Tick | null {
  const entry = coverage.get(step.roomId);
  const searched = entry === undefined ? null : searchedSinceTick(entry, ROUTE_MIN_FRESH_SEARCHED_FRACTION);
  const ticks = [searched, ...step.openingIds.map(id => ctx.latestOpening.get(id)?.tick ?? null)];
  return ticks.every((t): t is Tick => t !== null) ? Math.min(...ticks) : null;
}

/** The latest tick since which at least `fraction` of the room has been person-searched (its freshness profile), or null. */
function searchedSinceTick(entry: RoomCoverage, fraction: number): Tick | null {
  return (entry.searchedSince ?? []).find(step => step.fraction >= fraction)?.sinceTick ?? null;
}

/**
 * The step to sweep next, -1 when every step is fresh. The current pass runs from the first step through each
 * following step completed after the one before it (the first after the intervention); the next step is the first
 * after the pass's last whose evidence is not fresh, else (the pass has reached the end) the first stale step from
 * the start. A step completed out of order that is still fresh needs no new look.
 */
export function nextSweepStep(done: readonly (Tick | null)[], since: Tick, interventionTick: Tick | null): number {
  const fresh = (i: number) => (done[i] ?? -Infinity) >= since;
  let reached = -1;
  let previous = interventionTick === null ? -Infinity : interventionTick + 1;
  for (let i = 0; i < done.length; i++) {
    const tick = done[i];
    if (tick === null || tick < previous) break;
    reached = i;
    previous = tick;
  }
  const ahead = done.findIndex((_, i) => i > reached && !fresh(i));
  return ahead >= 0 ? ahead : done.findIndex((_, i) => !fresh(i));
}

/** The sweep's steps in reverse route order (see routeSweepCandidates); steps without a valid station are left out. */
function sweepSteps(ctx: Ctx, route: RouteAssessment, track: OccupantTrack): SweepStep[] {
  const points = route.waypoints.flatMap((p, i) => (i === 0 ? [p] : [scale(add(route.waypoints[i - 1], p), 0.5), p]));
  const rooms: PriorRoom[] = [];
  for (const p of points) {
    const room = roomContaining(ctx.prior, p);
    if (room !== null && rooms[rooms.length - 1]?.id !== room.id && !rooms.some(r => r.id === room.id)) rooms.push(room);
  }
  if (rooms.length === 0) return [];
  const crossed = ctx.prior.openings.filter(o => route.waypoints.some(p => distance(p, o.center) < 0.05));
  const steps: SweepStep[] = [];
  for (let i = rooms.length - 1; i >= 0; i--) {
    const room = rooms[i];
    const step = i === 0 ? doorwaySweepStep(ctx, room, rooms[1], crossed, track) : i === rooms.length - 1 ? exitSweepStep(ctx, room, crossed) : passSweepStep(ctx, room, route);
    if (step !== null) steps.push(step);
  }
  return steps;
}

/** The exit room: a station facing the crossed exterior opening (the exit door) from inside. */
function exitSweepStep(ctx: Ctx, room: PriorRoom, crossed: readonly PriorOpening[]): SweepStep | null {
  const exit = crossed.find(o => o.rooms.includes(room.id) && o.rooms.includes("exterior"));
  const normal = exit === undefined ? null : horizontalUnit(exit.outwardNormal);
  if (exit === undefined || normal === null) return passSweepStep(ctx, room, null);
  const inward = pointInPolygon(exit.center.x + normal.x, exit.center.y + normal.y, room.polygon) ? normal : scale(normal, -1);
  for (const depthM of SWEEP_EXIT_VIEW_M) {
    const station = round3(vec3(exit.center.x + inward.x * depthM, exit.center.y + inward.y * depthM, room.zMin + SWEEP_HOVER_M));
    if (stationClear(ctx, station, room) && ctx.reachable(station)) return { roomId: room.id, openingIds: [exit.id], station, lookAt: round3(exit.center), what: `facing exit ${exit.kind} ${label(exit.id)}` };
  }
  return passSweepStep(ctx, room, null);
}

/**
 * A room between: where the route enters it from the exit side, looking along the route; else its interior
 * point; else (a narrow corridor holds no point clear of both walls) the valid point of the room nearest the
 * route's path through it, on a SWEEP_GRID_M grid.
 */
function passSweepStep(ctx: Ctx, room: PriorRoom, route: RouteAssessment | null): SweepStep | null {
  const inside = route === null ? [] : route.waypoints.filter(p => pointInPolygon(p.x, p.y, room.polygon) && p.z >= room.zMin - 0.5 && p.z <= room.zMax);
  const interior = roomInteriorPoint(room);
  const lookAt = inside.length > 0 ? inside[0] : interior;
  if (lookAt === null) return null;
  const z = room.zMin + SWEEP_HOVER_M;
  const tried = [...inside.slice().reverse(), ...(interior === null ? [] : [interior])].map(p => round3(vec3(p.x, p.y, z)));
  const anchor = inside.length > 0 ? inside[inside.length - 1] : lookAt;
  const station = tried.find(p => stationClear(ctx, p, room) && ctx.reachable(p)) ?? nearestClearPoint(ctx, room, anchor, z);
  if (station === null) return null;
  const target = horizontalDistance(lookAt, station) > 0.5 ? lookAt : interior ?? lookAt;
  return { roomId: room.id, openingIds: [], station, lookAt: round3(target), what: "along the route" };
}

const SWEEP_GRID_M = 0.25;

/** The room's grid point nearest `anchor` that stationClear accepts at height z (ties by coordinates), or null. */
function nearestClearPoint(ctx: Ctx, room: PriorRoom, anchor: Vec3, z: number): Vec3 | null {
  const xs = room.polygon.map(p => p[0]);
  const ys = room.polygon.map(p => p[1]);
  let best: { readonly p: Vec3; readonly d: number } | null = null;
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += SWEEP_GRID_M) {
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += SWEEP_GRID_M) {
      const p = round3(vec3(x, y, z));
      const d = horizontalDistance(p, anchor);
      if ((best === null || d < best.d - 1e-9) && stationClear(ctx, p, room)) best = { p, d };
    }
  }
  return best !== null && ctx.reachable(best.p) ? best.p : null;
}

/** The occupant's room: a station in the next room on the route, by the doorway, at the guidance clearance, looking in. */
function doorwaySweepStep(ctx: Ctx, room: PriorRoom, next: PriorRoom | undefined, crossed: readonly PriorOpening[], track: OccupantTrack): SweepStep | null {
  const door = roomDoors(ctx, room).find(d => (next === undefined || d.other.id === next.id) && crossed.some(o => o.id === d.opening.id));
  if (door === undefined) return null;
  const c = door.opening.center;
  for (const depthM of SWEEP_DOOR_DEPTHS_M) {
    for (const offsetM of SWEEP_DOOR_OFFSETS_M) {
      const station = round3(vec3(c.x + door.out.x * depthM + door.along.x * offsetM, c.y + door.out.y * depthM + door.along.y * offsetM, door.other.zMin + SWEEP_HOVER_M));
      if (stationClear(ctx, station, door.other) && occupantTooClose(ctx, station, "guide") === null && sightThroughOpening(station, track.position, door.opening, door.out, door.along) && ctx.reachable(station)) {
        return { roomId: room.id, openingIds: [door.opening.id], station, lookAt: round3(track.position), what: `from beyond ${door.opening.kind} ${label(door.opening.id)}, looking in` };
      }
    }
  }
  return null;
}

/* guide_to_exit: only along a fresh, supported evacuation route. */

function guideCandidates(ctx: Ctx): ProposalCandidate[] {
  const modules = ctx.profile.modules;
  const routes = supportedEvacuationRoutes(ctx);
  if ((!modules.lightCue && !modules.speaker) || routes.length === 0) return [];
  const templateIds = guidanceTemplates(ctx);
  const cues = modules.lightCue && modules.speaker ? "the light cue and approved audio" : modules.lightCue ? "the light cue" : "approved audio";
  const enRoute = new Set(ctx.escorts.flatMap(e => (e.state === "en_route" && e.track !== null ? [e.track.id] : [])));
  return ctx.belief.tracks.flatMap(track => {
    // Someone guided who has since left or arrived needs no more guidance; one still on the way out may get it again.
    if (track.status !== "possible" || (ctx.guidedIds.has(track.id) && !enRoute.has(track.id))) return [];
    const route = nearestRouteStart(routes, track.position);
    const maxDurationTicks = guideDurationTicks(ctx, route);
    if (maxDurationTicks === null) return [];
    // DEMO: never start guidance with the aircraft on the person's way out (the occupant walked into it at the
    // spray standoff): move off it first.
    const clearFirst = standClearBeforeGuiding(ctx, track, route);
    if (clearFirst !== null) return [clearFirst];
    const description = `Guide possible occupant ${label(track.id)} along evacuation route ${label(route.id)} (supported, assessed ${ageText(ctx, route.assessedTick)} ago) with ${cues}.`;
    return [build(ctx, {
      id: candidateId("guide_to_exit", track.id, route.id),
      tool: "guide_to_exit",
      description,
      rationale: `${description} Guidance stops if the route stops being supported. ${sanitizeText(route.reason, 160)}`,
      target: target({ roomId: track.roomId, trackId: track.id, routeId: route.id, station: round3(route.waypoints[0]), focus: round3(route.waypoints[route.waypoints.length - 1]), evidenceTick: route.assessedTick }),
      action: { kind: "guide", trackId: track.id, routeId: route.id, templateIds, maxDurationTicks },
      cited: cite(ctx, route.evidenceIds),
    })];
  });
}

/** Guidance starts only with the aircraft at least this far (horizontally, same floor) from the person's remaining route. */
const GUIDE_WAY_CLEAR_M = 1.5;
/** A stand-clear station before guidance keeps this much more than GUIDE_WAY_CLEAR_M from that route. */
const GUIDE_WAY_STATION_MARGIN_M = 0.3;

/**
 * When the aircraft is within GUIDE_WAY_CLEAR_M of the occupant's remaining route (from the occupant along the route
 * from guideLeadIndex on), a move to the nearest station off it (ring search around the aircraft, the stand-clear
 * checks: clear of walls, the guidance clearance from people, reachable by a clear way) before guidance is offered.
 * Null when the aircraft is already clear, or when no such station exists (guidance is then offered as before).
 */
function standClearBeforeGuiding(ctx: Ctx, track: OccupantTrack, route: RouteAssessment): ProposalCandidate | null {
  const way = [track.position, ...route.waypoints.slice(guideLeadIndex(route.waypoints, track, ctx.harness))];
  const offM = pathDistanceM(way, ctx.pose);
  if (!(offM < GUIDE_WAY_CLEAR_M)) return null;
  const needM = GUIDE_WAY_CLEAR_M + GUIDE_WAY_STATION_MARGIN_M;
  const cost = (p: Vec3) => horizontalDistance(ctx.pose, p) + (overFloor(ctx, p) ? 0 : NO_FLOOR_PENALTY_M);
  const station = ringPoints(ctx.pose, track.position)
    .filter(p => pathDistanceM(way, p) >= needM && stationClear(ctx, p, roomContaining(ctx.prior, p)) && occupantTooClose(ctx, p, "guide") === null)
    .map((p, order) => ({ p, order, cost: cost(p) }))
    .sort((a, b) => a.cost - b.cost || a.order - b.order)
    .slice(0, STAND_CLEAR_MAX_TRIES)
    .find(entry => ctx.reachable(entry.p) && accessClear(ctx, ctx.pose, entry.p))?.p ?? null;
  if (station === null) return null;
  const room = roomContaining(ctx.prior, station);
  const description = `Before guiding possible occupant ${label(track.id)}: move off their way out (now ${fmt(offM)} m from it) to a station ${fmt(pathDistanceM(way, station))} m from it, then guide along route ${label(route.id)}.`;
  return build(ctx, {
    id: candidateId("investigate_signal", track.id, STAND_CLEAR_SUFFIX),
    tool: "investigate_signal",
    description,
    rationale: `${description} Guidance never starts with the aircraft on the person's path. Moving changes nothing else.`,
    target: target({ roomId: room?.id ?? null, trackId: track.id, routeId: route.id, station, focus: round3(track.position), evidenceTick: track.lastSeenTick }),
    action: moveTo(ctx, station),
    cited: cite(ctx, track.observationIds),
  });
}

function supportedEvacuationRoutes(ctx: Ctx): RouteAssessment[] {
  const after = ctx.lastInterventionTick;
  return latestRoutes(ctx.belief.routes).filter(route =>
    route.purpose === "evacuation"
    && route.status === "supported"
    && route.assessedTick >= ctx.now - ctx.policy.routeFreshTicks
    && route.waypoints.length > 0
    // Suppression changes conditions; only an assessment made after it can support guidance.
    && (after === null || route.assessedTick > after));
}

function nearestRouteStart(routes: readonly RouteAssessment[], position: Vec3): RouteAssessment {
  return routes.slice().sort((a, b) => distance(a.waypoints[0], position) - distance(b.waypoints[0], position) || a.estimatedDurationS - b.estimatedDurationS || compareText(a.id, b.id))[0];
}

/** Up to twice the route estimate plus 30 s, within endurance above the return reserve. */
function guideDurationTicks(ctx: Ctx, route: RouteAssessment): number | null {
  const availableS = ctx.belief.aircraft.enduranceRemainingS - ctx.profile.hardLimits.returnReserveS;
  if (!(availableS > route.estimatedDurationS)) return null;
  const durationS = Math.min(route.estimatedDurationS * GUIDE_DURATION_FACTOR + GUIDE_DURATION_EXTRA_S, availableS);
  const ticks = Math.min(MAX_DURATION_TICKS, Math.floor(durationS / TICK_S + 1e-9));
  return ticks >= 1 ? ticks : null;
}

/** Approved scenario templates that are truthful for this aircraft; never a dispatch claim. */
function guidanceTemplates(ctx: Ctx): string[] {
  const wanted = ctx.profile.modules.lightCue ? ["follow-light", "stay-low"] : ["exit-ahead", "stay-low"];
  return wanted.filter(id => SPEECH_TEMPLATES.some(template => template.id === id && !template.requiresDispatchConfirmed));
}

/*
 * After guidance. Once guidance has run for a track (the runtime reports every guide that began executing), the
 * guided person walks the evacuation route out, whether or not the guide still runs: it ends on its time limit,
 * not on arrival. Until the track has left or its arrival is confirmed, the aircraft keeps off that person's way
 * out:
 *   - their remaining path is their position, then the guided route's waypoints from the one nearest them to the
 *     route's end beyond the exit. No second look, sweep or inspection is offered whose station lies within the
 *     guidance standoff of it (personStandoffM for a guide: policy guidanceClearanceM, half the span, the
 *     track's uncertainty and PERSON_STATION_MARGIN_M), or whose drone path enters that band, or moves nearer
 *     the person while inside it (an aircraft already on the path may still back away from them);
 *   - a stand-clear look (investigate_signal, id suffix STAND_CLEAR_SUFFIX) holds the aircraft at the nearest
 *     station outside that band, clear of the walls and of the person by the guidance clearance, beside the
 *     route or out ahead of them, facing them so the cameras see them leave. No second look at the guided track
 *     and no route sweep for it is offered; guidance may be offered again while they are inside;
 *   - return_to_base waits.
 * The person is followed across their tracks (sameGuidedPerson): a person walking out is often picked up again
 * as a new track. They have left when their newest track is seen outside, clear of the building, or when later
 * looks have searched their whole way out inside, from where they were last seen to the exit, and found no one
 * (the harness's later-look rule, at WAY_OUT_SAMPLE_M spacing); the stand-clear look faces the first point not
 * yet searched. Seen on the move and gone from there on a later look, they are presumed out once the rest of the
 * way would have taken a slow walk (presumedOut). Their arrival is confirmed when one of their tracks is seen at the
 * assembly point or a crew confirmation names it. None of these is an evacuation claim; each only ends the
 * stand-clear. Stand-clear stations over a floor are preferred (NO_FLOOR_PENALTY_M), so a landing stays possible;
 * when no station keeps clear with a way there that does not cross the person's path, the aircraft holds where it
 * is and faces the way out.
 */
const STAND_CLEAR_SUFFIX = "stand-clear";
const HOMEWARD_SUFFIX = "homeward";
/** Spacing of the points along a guided person's way out that later looks must have found empty. */
const WAY_OUT_SAMPLE_M = 0.5;
/** A guided person seen on the move and gone from there is presumed out after walking the rest at this pace, plus this margin (presumedOut). */
const PRESUMED_WALK_MPS = 0.5;
const PRESUMED_MARGIN_S = 10;
/** A stand-clear station over no floor (a stair or stairwell) counts this much farther away: holding over a floor keeps a landing possible. */
const NO_FLOOR_PENALTY_M = 1.5;
/** Stand-clear stations are searched on rings around the aircraft: this spacing, out to this radius, at this many bearings. */
const STAND_CLEAR_RING_STEP_M = 0.5;
const STAND_CLEAR_MAX_RADIUS_M = 6;
const STAND_CLEAR_BEARINGS = 16;
/** Stations passing the cheap checks that are tested for reach and access, nearest first, before giving up. */
const STAND_CLEAR_MAX_TRIES = 24;
const MAX_MERGE_HOPS = 8;

type EscortState = "en_route" | "left" | "arrived" | "retracted";

interface Escort {
  readonly guidedId: TrackId;
  /** The guided person's possible tracks (sameGuidedPerson). */
  readonly members: readonly TrackId[];
  /** The most recently seen of them; null when none is left in the belief. */
  readonly track: OccupantTrack | null;
  readonly sinceTick: Tick;
  readonly state: EscortState;
  /** The person's remaining path to the route's end; empty unless en route. */
  readonly path: readonly Vec3[];
  /** The first point of their way out inside that no later look has found empty (unclearedWayOut); null unless en route. */
  readonly watch: Vec3 | null;
  readonly standoffM: number;
}

/** A stand-clear look (see the after-guidance section). */
export function isStandClear(candidate: MissionCandidate): boolean {
  return candidate.tool === "investigate_signal" && candidate.id.endsWith(`:${STAND_CLEAR_SUFFIX}`);
}

/** A return to base once every guided occupant has left or arrived (see returnCandidates). */
export function isHomeward(candidate: MissionCandidate): boolean {
  return candidate.tool === "return_to_base" && candidate.id.endsWith(`:${HOMEWARD_SUFFIX}`);
}

/** One escort per current track, from the latest guide that led it. */
function escortsOf(guided: readonly GuidedTrack[], harness: HarnessContext): Escort[] {
  const byTrack = new Map<string, Escort>();
  for (const g of [...guided].sort((a, b) => a.sinceTick - b.sinceTick || compareText(a.trackId, b.trackId))) {
    const escort = escortOf(harness, g);
    byTrack.set(escort.track?.id ?? g.trackId, escort);
  }
  return [...byTrack.values()].sort((a, b) => compareText(a.guidedId, b.guidedId));
}

function currentTrack(belief: BeliefSnapshot, id: TrackId): OccupantTrack | null {
  let track = belief.tracks.find(t => t.id === id) ?? null;
  for (let hop = 0; hop < MAX_MERGE_HOPS && track !== null && track.status === "merged" && track.mergedInto !== null; hop++) {
    const into: TrackId = track.mergedInto;
    track = belief.tracks.find(t => t.id === into) ?? null;
  }
  return track;
}

function guidedRoute(belief: BeliefSnapshot, routeId: RouteId): RouteAssessment | null {
  const routes = latestRoutes(belief.routes);
  return routes.find(r => r.id === routeId && r.waypoints.length > 0) ?? routes.find(r => r.purpose === "evacuation" && r.waypoints.length > 0) ?? null;
}

function guideStandoffM(harness: HarnessContext, track: OccupantTrack): number {
  return requiredPersonDistanceM(harness, track.uncertaintyM, personClearanceFor(harness, "guide")) + PERSON_STATION_MARGIN_M;
}

/**
 * The guided person's possible tracks: the guided track (through merges), tracks marked as possibly the same
 * person, and tracks first seen after guidance began within the guidance standoff of the guided route (a person
 * walking out is often picked up again as a new track while the guided one stays where they were last seen).
 */
function sameGuidedPerson(harness: HarnessContext, guided: GuidedTrack, route: RouteAssessment | null): OccupantTrack[] {
  const tracks = harness.belief.tracks;
  const own = currentTrack(harness.belief, guided.trackId);
  const linked = (t: OccupantTrack) => own !== null && (t.id === own.id || own.ambiguousWith.includes(t.id) || t.ambiguousWith.includes(own.id));
  const pickedUp = (t: OccupantTrack) => route !== null && t.firstSeenTick >= guided.sinceTick && pathDistanceM(route.waypoints, t.position) <= guideStandoffM(harness, t);
  return tracks.filter(t => t.status === "possible" && (linked(t) || pickedUp(t)));
}

function escortOf(harness: HarnessContext, guided: GuidedTrack): Escort {
  const belief = harness.belief;
  const route = guidedRoute(belief, guided.routeId);
  const members = sameGuidedPerson(harness, guided, route);
  const track = members.slice().sort((a, b) => b.lastSeenTick - a.lastSeenTick || compareText(a.id, b.id))[0] ?? null;
  const base = { guidedId: guided.trackId, members: members.map(t => t.id), track, sinceTick: guided.sinceTick, path: [], watch: null };
  if (track === null) return { ...base, standoffM: 0, state: "retracted" };
  const standoffM = guideStandoffM(harness, track);
  if (arrivalConfirmed(belief, members, guided.trackId)) return { ...base, standoffM, state: "arrived" };
  const exits = routeExits(belief.mapPrior, route);
  const path = route === null ? [track.position, ...exits.slice(0, 1).map(o => o.center)] : [track.position, ...route.waypoints.slice(nearestIndex(route.waypoints, track.position))];
  const inside = insidePart(path, exits);
  const watch = seenOutside(belief.mapPrior, track) ? null : unclearedWayOut(harness, track, inside);
  if (watch === null || presumedOut(harness, guided, track, inside)) return { ...base, standoffM, state: "left" };
  return { ...base, standoffM, state: "en_route", path, watch };
}

/**
 * Seen on the move (last seen outside the room the guided track was in) and gone from there on a later look, and
 * not seen since for longer than walking the rest of the way out at PRESUMED_WALK_MPS takes, plus
 * PRESUMED_MARGIN_S: presumed out. Where the aircraft cannot see the way to the exit (from upstairs, say), this
 * ends the stand-clear; it is not an evacuation claim, and someone who never left their room is never presumed out.
 */
function presumedOut(harness: HarnessContext, guided: GuidedTrack, track: OccupantTrack, inside: readonly Vec3[]): boolean {
  const prior = harness.belief.mapPrior;
  const start = currentTrack(harness.belief, guided.trackId) ?? track;
  const lastRoom = roomContaining(prior, track.position)?.id ?? null;
  if (lastRoom !== null && lastRoom === roomContaining(prior, start.position)?.id) return false;
  if (!clearedByLaterLook(track.position, track.uncertaintyM, track.lastSeenTick, harness)) return false;
  const walkS = polylineLengthM(inside) / PRESUMED_WALK_MPS + PRESUMED_MARGIN_S;
  return (harness.belief.tick - track.lastSeenTick) * TICK_S >= walkS;
}

function polylineLengthM(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

/** The exterior openings the route crosses, else the prior's exits. */
function routeExits(prior: FloorPlanPrior, route: RouteAssessment | null): PriorOpening[] {
  const crossed = route === null ? [] : prior.openings.filter(o => o.rooms.includes("exterior") && route.waypoints.some(p => distance(p, o.center) < 0.05));
  if (crossed.length > 0) return crossed;
  const ids = new Set(prior.exits.map(exit => exit.openingId));
  return prior.openings.filter(o => ids.has(o.id));
}

function arrivalConfirmed(belief: BeliefSnapshot, members: readonly OccupantTrack[], guidedId: TrackId): boolean {
  const ids = new Set([guidedId, ...members.map(t => t.id)]);
  return belief.crewConfirmations.some(c => c.trackId !== null && ids.has(c.trackId)) || members.some(t => distanceToRegion(belief.mapPrior.assemblyPoint, t.position) <= Math.max(0, t.uncertaintyM));
}

function seenOutside(prior: FloorPlanPrior, track: OccupantTrack): boolean {
  const p = track.position;
  return roomContaining(prior, p) === null && clearOfRooms(prior, [p.x, p.y], Math.max(0, track.uncertaintyM) + EXIT_APPROACH_M);
}

/** The path up to and including its first point at an exit opening (all of it when it reaches none). */
function insidePart(path: readonly Vec3[], exits: readonly PriorOpening[]): Vec3[] {
  const at = path.findIndex((p, i) => i > 0 && exits.some(o => distance(p, o.center) < 0.05));
  return at < 0 ? [...path] : path.slice(0, at + 1);
}

/**
 * The first point of the person's way out inside the building, from where they were last seen to the exit, that no
 * later look has searched and found empty (harness clearedByLaterLook, with the track's uncertainty); null when
 * later looks cover all of it without seeing anyone, so the person has gone out. Facing it is where to look next.
 */
function unclearedWayOut(harness: HarnessContext, track: OccupantTrack, inside: readonly Vec3[]): Vec3 | null {
  let found: Vec3 | null = null;
  everySample(inside, q => {
    if (clearedByLaterLook(q, track.uncertaintyM, track.lastSeenTick, harness)) return true;
    found = q;
    return false;
  }, WAY_OUT_SAMPLE_M);
  return found;
}

function guidedTrackIds(belief: BeliefSnapshot, guided: readonly GuidedTrack[], escorts: readonly Escort[]): Set<TrackId> {
  const ids = new Set<TrackId>([...guided.map(g => g.trackId), ...escorts.flatMap(e => e.members)]);
  for (const escort of escorts) for (const id of escort.track?.ambiguousWith ?? []) ids.add(id);
  for (const track of belief.tracks) if (track.ambiguousWith.some(id => ids.has(id))) ids.add(track.id);
  return ids;
}

function walkingEscorts(ctx: Ctx): (Escort & { readonly track: OccupantTrack })[] {
  return ctx.escorts.filter((e): e is Escort & { readonly track: OccupantTrack } => e.state === "en_route" && e.track !== null);
}

/** Horizontal distance from `q` to the path, over the parts of it on q's floor (Infinity when none is). */
function pathDistanceM(path: readonly Vec3[], q: Vec3): number {
  if (path.length === 1) return Math.abs(path[0].z - q.z) <= PERSON_SAME_FLOOR_M ? horizontalDistance(path[0], q) : Infinity;
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : clamp01(((q.x - a.x) * dx + (q.y - a.y) * dy) / lengthSq);
    if (Math.abs(a.z + (b.z - a.z) * t - q.z) > PERSON_SAME_FLOOR_M) continue;
    best = Math.min(best, Math.hypot(q.x - (a.x + dx * t), q.y - (a.y + dy * t)));
  }
  return best;
}

/** Inside the guidance standoff of a walking guided person's remaining path. */
function onWayOut(ctx: Ctx, p: Vec3): boolean {
  return walkingEscorts(ctx).some(e => pathDistanceM(e.path, p) < e.standoffM);
}

/**
 * The drone path from `from` to `to` never enters a walking guided person's band (path plus standoff) from
 * outside it, and while inside it (the aircraft already on their way out) never comes nearer the person than
 * at `from`: it backs away along or off the path, never toward them. A missing path counts as the straight line.
 */
function keepsOffWayOut(ctx: Ctx, from: Vec3, to: Vec3): boolean {
  const walking = walkingEscorts(ctx);
  if (walking.length === 0) return true;
  const points = dronePath(ctx, from, to) ?? [from, to];
  return walking.every(escort => {
    const person = escort.track.position;
    const startM = horizontalDistance(from, person);
    let backingAway = pathDistanceM(escort.path, from) < escort.standoffM;
    return everySample(points, q => {
      if (pathDistanceM(escort.path, q) >= escort.standoffM) {
        backingAway = false;
        return true;
      }
      return backingAway && horizontalDistance(q, person) >= startM - 1e-6;
    });
  });
}

/** Observation moves that keep off every walking guided person's way out; the rest are left out, with a note. */
function keepOffWaysOut(ctx: Ctx, looks: readonly ProposalCandidate[], notes: Note[]): ProposalCandidate[] {
  const walking = walkingEscorts(ctx);
  if (walking.length === 0) return [...looks];
  const kept = looks.filter(c => c.target.station === null || (!onWayOut(ctx, c.target.station) && keepsOffWayOut(ctx, ctx.pose, c.target.station)));
  const crossing = looks.filter(c => !kept.includes(c));
  if (crossing.length > 0) {
    notes.push({ candidateId: null, text: `Keeping off the way out of guided occupant track ${label(walking[0].guidedId)} (${fmt(walking[0].standoffM)} m from their remaining route): not offering ${idList(crossing)}.` });
  }
  return kept;
}

/** A stand-clear look per walking guided person (see the after-guidance section). */
function standClearCandidates(ctx: Ctx, notes: Note[]): ProposalCandidate[] {
  return walkingEscorts(ctx).flatMap(escort => {
    const track = escort.track;
    const id = candidateId("investigate_signal", track.id, STAND_CLEAR_SUFFIX);
    const found = standClearStation(ctx, id, track.position);
    if (found === null) notes.push({ candidateId: null, text: `No stand-clear station within ${fmt(STAND_CLEAR_MAX_RADIUS_M)} m keeps ${fmt(escort.standoffM)} m from the way out of guided occupant track ${label(escort.guidedId)} with a way there that does not cross it: holding here.` });
    const station = found ?? round3(ctx.pose);
    const inPlace = atStation(ctx, station);
    const offM = Math.min(...walkingEscorts(ctx).map(e => pathDistanceM(e.path, station)));
    const room = roomContaining(ctx.prior, station);
    const watch = round3(escort.watch ?? track.position);
    const facing = horizontalDistance(watch, track.position) < 0.05 ? "face them" : "face the part of their way out not yet seen empty";
    const description = `Stand clear of guided occupant track ${label(track.id)}'s way out: ${inPlace ? "hold here" : "move to a station"} ${fmt(offM)} m from their remaining route (at least ${fmt(escort.standoffM)} m) and ${facing} to see them leave.`;
    return [build(ctx, {
      id,
      tool: "investigate_signal",
      description,
      rationale: `${description} Guidance has run for this track (from ${ageText(ctx, escort.sinceTick)} ago); until the track has left or its arrival is confirmed, no second look, route sweep or inspection crosses their path and the return waits. Watching them leave is observation only; it is not an evacuation claim.`,
      target: target({ roomId: room?.id ?? null, trackId: track.id, station, focus: watch, evidenceTick: track.lastSeenTick }),
      action: inPlace ? { kind: "scan", lookAt: watch, durationTicks: SCAN_TICKS } : moveTo(ctx, station),
      cited: cite(ctx, track.observationIds),
    })];
  });
}

/**
 * The incumbent while still valid, else the nearest point on rings around the aircraft (the aircraft's own
 * position first; on each ring, farthest from the person first) that is clear of the walls and envelope, keeps
 * the guidance clearance from every possible occupant and the standoff from every walking guided person's path,
 * and is reachable by a way that keeps person clearance and keeps off the way out.
 */
function standClearStation(ctx: Ctx, id: string, person: Vec3): Vec3 | null {
  const usable = (p: Vec3) => ctx.reachable(p) && accessClear(ctx, ctx.pose, p) && keepsOffWayOut(ctx, ctx.pose, p);
  const kept = incumbentStation(ctx, id);
  if (kept !== null && standClearPoint(ctx, kept) && overFloor(ctx, kept) && usable(kept)) return kept;
  const cost = (p: Vec3) => horizontalDistance(ctx.pose, p) + (overFloor(ctx, p) ? 0 : NO_FLOOR_PENALTY_M);
  const ranked = ringPoints(ctx.pose, person).filter(p => standClearPoint(ctx, p)).map((p, order) => ({ p, order, cost: cost(p) }));
  ranked.sort((a, b) => a.cost - b.cost || a.order - b.order);
  return ranked.slice(0, STAND_CLEAR_MAX_TRIES).find(entry => usable(entry.p))?.p ?? null;
}

/** Over a floor: in a room, and clear (by half the span) of every stair's footprint, which also covers its stairwell above. */
function overFloor(ctx: Ctx, p: Vec3): boolean {
  if (roomContaining(ctx.prior, p) === null) return false;
  const marginM = ctx.profile.spanM / 2;
  return (ctx.prior.stairs ?? []).every(stair => {
    const dx = stair.top.x - stair.bottom.x;
    const dy = stair.top.y - stair.bottom.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : clamp01(((p.x - stair.bottom.x) * dx + (p.y - stair.bottom.y) * dy) / lengthSq);
    return Math.hypot(p.x - (stair.bottom.x + dx * t), p.y - (stair.bottom.y + dy * t)) > stair.widthM / 2 + marginM;
  });
}

function standClearPoint(ctx: Ctx, p: Vec3): boolean {
  return stationClear(ctx, p, roomContaining(ctx.prior, p)) && occupantTooClose(ctx, p, "guide") === null && !onWayOut(ctx, p);
}

function ringPoints(center: Vec3, person: Vec3): Vec3[] {
  const points = [round3(center)];
  for (let radiusM = STAND_CLEAR_RING_STEP_M; radiusM <= STAND_CLEAR_MAX_RADIUS_M + 1e-9; radiusM += STAND_CLEAR_RING_STEP_M) {
    const ring = Array.from({ length: STAND_CLEAR_BEARINGS }, (_, k) => {
      const angle = (2 * Math.PI * k) / STAND_CLEAR_BEARINGS;
      return round3(vec3(center.x + radiusM * Math.cos(angle), center.y + radiusM * Math.sin(angle), center.z));
    });
    points.push(...ring.map((p, k) => ({ p, k, away: horizontalDistance(p, person) })).sort((a, b) => b.away - a.away || a.k - b.k).map(entry => entry.p));
  }
  return points;
}

function atStation(ctx: Ctx, p: Vec3): boolean {
  return horizontalDistance(ctx.pose, p) <= ctx.policy.arrivalToleranceM && Math.abs(ctx.pose.z - p.z) <= VERTICAL_ARRIVAL_M;
}

/**
 * Every possible track has been guided and has left or arrived (or is gone), and no fire is seen burning that is
 * still to be suppressed (a fire water is unsafe for is left to the crews: awaitingSuppression).
 */
function homeward(ctx: Ctx): boolean {
  if (ctx.escorts.length === 0 || ctx.escorts.some(e => e.state === "en_route") || awaitingSuppression(ctx)) return false;
  return possibleTracks(ctx).every(t => ctx.guidedIds.has(t.id));
}

function homewardReason(ctx: Ctx): string {
  const states = ctx.escorts.map(e => `track ${label(e.guidedId)} ${e.state === "arrived" ? "seen at the assembly point or confirmed by a crew" : e.state === "left" ? "seen outside, or their way out searched empty since" : "is no longer tracked"}`);
  const fires = latestFires(ctx).length === 0 ? "no fire is seen burning" : "no fire water may be used on is seen burning (water is unsafe for the fire still seen)";
  return `Guidance has run for every possible occupant (${states.join("; ")}) and ${fires}, so returning comes first.`;
}

/*
 * Return-route refresh. Once the return is homeward (every guided occupant has left or arrived, no fire burning) but
 * no return route is supported, and the latest return route is "unknown" for want of evidence the aircraft can
 * gather: doors on it not observed within policy.routeEvidenceMaxAgeTicks (or not since the intervention), and fire
 * places beside it not looked at since (the route assessor's opening and fire checks). Those places are looked at,
 * nearest along the route first, so the homeward return becomes supported: one look at a time, from where the
 * aircraft is when it sees the place, else from the nearest station that does (in a room beside it, within
 * REFRESH_VIEW_MAX_M, with a clear line inside that room, and facing a door within 60° of its normal), in the
 * aircraft's own room first and over a floor if that costs no more than NO_FLOOR_PENALTY_M. The local
 * planner ranks it first while no return is on offer.
 */
const REFRESH_SUFFIX = "return-refresh";
const REFRESH_VIEW_RADII_M = [1.2, 1.6, 2.0, 2.5];
const REFRESH_VIEW_MAX_M = 3.0;
const REFRESH_BEARINGS = 16;
/** Stations passing the cheap checks that are tested for reach and access, nearest first. */
const REFRESH_MAX_TRIES = 16;
/** A door is seen from within this angle of its normal (cosine). */
const REFRESH_MIN_FACING_COS = 0.5;
/** Fire places within this of the route count as beside it (the route corridor's half width, plus a margin). */
const REFRESH_FIRE_REACH_M = 0.8;
/** The route assessor looks for a fire place this far above the floor under it. */
const FIRE_VIEW_HEIGHT_M = 0.3;

interface RefreshTarget {
  readonly point: Vec3;
  readonly roomIds: readonly RoomId[];
  /** A door's horizontal normal (it is seen from in front or behind), else null. */
  readonly normal: Vec3 | null;
  readonly what: string;
  /** Position along the route (index of the nearest waypoint). */
  readonly order: number;
}

/** A return-route refresh look (see returnRefreshCandidates). */
export function isReturnRefresh(candidate: MissionCandidate): boolean {
  return candidate.tool === "inspect_room" && candidate.id.endsWith(`:${REFRESH_SUFFIX}`);
}

function returnRefreshCandidates(ctx: Ctx, notes: Note[]): ProposalCandidate[] {
  if (!homeward(ctx)) return [];
  const routes = latestRoutes(ctx.belief.routes).filter(r => r.purpose !== "evacuation" && r.waypoints.length > 1);
  if (routes.some(r => r.status === "supported" && r.assessedTick >= ctx.now - ctx.policy.returnRouteFreshTicks)) return [];
  const route = routes.filter(r => r.status === "unknown").sort((a, b) => a.estimatedDurationS - b.estimatedDurationS || compareText(a.id, b.id))[0];
  const goal = route === undefined ? undefined : refreshTargets(ctx, route)[0];
  if (route === undefined || goal === undefined) return [];
  const station = refreshStation(ctx, goal);
  if (station === null) {
    notes.push({ candidateId: null, text: `Return route ${label(route.id)} needs a fresh look at ${goal.what}, but no station within ${fmt(REFRESH_VIEW_MAX_M)} m sees it clear of walls and people.` });
    return [];
  }
  const room = roomContaining(ctx.prior, station);
  const inPlace = atStation(ctx, station);
  const description = `Refresh return route ${label(route.id)} before going home: ${inPlace ? "look at" : "move to see"} ${goal.what}. Observation only; it does not mark any room empty.`;
  return [build(ctx, {
    id: candidateId("inspect_room", room?.id ?? goal.roomIds[0] ?? "exterior", REFRESH_SUFFIX),
    tool: "inspect_room",
    description,
    rationale: `${description} Every guided occupant has left or arrived; the return route is ${route.status}: ${sanitizeText(route.reason, 200)}`,
    target: target({ roomId: room?.id ?? null, routeId: route.id, station, focus: goal.point, evidenceTick: null }),
    action: inPlace ? { kind: "scan", lookAt: goal.point, durationTicks: SCAN_TICKS } : moveTo(ctx, station),
    cited: [],
  })];
}

/** What the route assessor still needs freshly observed on the route, in route order. */
function refreshTargets(ctx: Ctx, route: RouteAssessment): RefreshTarget[] {
  const since = Math.max(ctx.now - ctx.policy.routeEvidenceMaxAgeTicks, (ctx.lastInterventionTick ?? -1) + 1);
  const doors = ctx.prior.openings.flatMap(opening => {
    const order = route.waypoints.findIndex(p => distance(p, opening.center) < 0.05);
    const seen = ctx.latestOpening.get(opening.id);
    if (order < 0 || seen?.state === "broken" || (seen !== undefined && seen.tick >= since)) return [];
    const age = seen === undefined ? "not yet observed" : `last observed ${seen.state} ${ageText(ctx, seen.tick)} ago`;
    const rooms = opening.rooms.filter(id => id !== "exterior") as RoomId[];
    return [{ point: opening.center, roomIds: rooms, normal: horizontalUnit(opening.outwardNormal), what: `${opening.kind} ${label(opening.id)} (${age})`, order }];
  });
  return [...doors, ...fireRefreshTargets(ctx, route, since)].sort((a, b) => a.order - b.order || compareText(a.what, b.what));
}

/** Places a flame was seen beside the route that no look has found without flame since (and within the age limit). */
function fireRefreshTargets(ctx: Ctx, route: RouteAssessment, since: Tick): RefreshTarget[] {
  const flames = ctx.belief.hazards.filter(h => h.hazard === "fire" && h.intensity > 0);
  const places = new Map<string, HazardEvidence>();
  for (const h of flames) {
    const key = fireKey(h);
    if ((places.get(key)?.tick ?? -Infinity) < h.tick) places.set(key, h);
  }
  return [...places.values()].flatMap(h => {
    const center = regionCenter(h.region);
    const room = roomContaining(ctx.prior, center);
    const point = round3(vec3(center.x, center.y, room === null ? center.z : Math.max(center.z, room.zMin + FIRE_VIEW_HEIGHT_M)));
    const order = nearestIndex(route.waypoints, point);
    // Beside the route as the assessor's corridor counts it: horizontally (its corridor is a vertical prism), on the same floor.
    const apart = everySample(route.waypoints, q => Math.abs(q.z - center.z) > PERSON_SAME_FLOOR_M || distanceToRegion(h.region, vec3(q.x, q.y, center.z)) > REFRESH_FIRE_REACH_M);
    if (apart || room === null || fireLookedAt(ctx, point, Math.max(since, h.tick + 1))) return [];
    return [{ point, roomIds: [room.id], normal: null, what: `the place in ${roomLabel(room)} where fire was seen ${ageText(ctx, h.tick)} ago`, order }];
  });
}

function fireKey(h: HazardEvidence): string {
  const c = regionCenter(h.region);
  return `${Math.round(c.x * 2)},${Math.round(c.y * 2)},${Math.round(c.z)}`;
}

function regionCenter(region: Region): Vec3 {
  const b = regionBounds(region);
  return vec3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
}

/** A later adequate look covers the place, or a later sighting there shows no flame. */
function fireLookedAt(ctx: Ctx, point: Vec3, from: Tick): boolean {
  if (ctx.belief.hazards.some(h => h.hazard === "fire" && h.intensity <= 0 && h.tick >= from && distanceToRegion(h.region, point) <= REFRESH_FIRE_REACH_M)) return true;
  return ctx.belief.observations.some(o => o.captureTick >= from && o.quality >= ctx.policy.minCoverageQuality && o.footprint !== null && (o.modality === "rgb" || o.modality === "thermal") && regionContains(o.footprint, point) && !o.detections.some(d => d.kind === "hazard" && d.hazard === "fire" && d.intensity > 0 && distanceToRegion(d.region, point) <= REFRESH_FIRE_REACH_M));
}

/** Where the aircraft is, when that sees the target; else the nearest reachable station that does. */
function refreshStation(ctx: Ctx, goal: RefreshTarget): Vec3 | null {
  const here = roomContaining(ctx.prior, ctx.pose);
  if (here !== null && seesTarget(here, ctx.pose, goal)) return round3(ctx.pose);
  const options: Vec3[] = [];
  for (const radiusM of REFRESH_VIEW_RADII_M) {
    for (let k = 0; k < REFRESH_BEARINGS; k++) {
      const angle = (2 * Math.PI * k) / REFRESH_BEARINGS;
      for (const roomId of goal.roomIds) {
        const room = ctx.rooms.get(roomId);
        const p = room === undefined ? null : round3(vec3(goal.point.x + radiusM * Math.cos(angle), goal.point.y + radiusM * Math.sin(angle), room.zMin + SWEEP_HOVER_M));
        if (room !== undefined && p !== null && seesTarget(room, p, goal) && stationClear(ctx, p, room)) options.push(p);
      }
    }
  }
  // On the aircraft's own side of a door first: the far side is reached only through the door being looked at.
  const side = (p: Vec3) => (here !== null && pointInPolygon(p.x, p.y, here.polygon) && p.z >= here.zMin && p.z <= here.zMax ? 0 : 1);
  const cost = (p: Vec3) => horizontalDistance(ctx.pose, p) + (overFloor(ctx, p) ? 0 : NO_FLOOR_PENALTY_M);
  options.sort((a, b) => side(a) - side(b) || cost(a) - cost(b));
  return options.slice(0, REFRESH_MAX_TRIES).find(p => ctx.reachable(p) && accessClear(ctx, ctx.pose, p)) ?? null;
}

/** From `p` in `room` (one beside the target), within range, facing a door from in front or behind, on a line inside the room. */
function seesTarget(room: PriorRoom, p: Vec3, goal: RefreshTarget): boolean {
  if (!goal.roomIds.includes(room.id) || !pointInPolygon(p.x, p.y, room.polygon) || p.z < room.zMin || p.z > room.zMax) return false;
  const lengthM = horizontalDistance(p, goal.point);
  if (lengthM > REFRESH_VIEW_MAX_M || lengthM < 0.3) return false;
  if (goal.normal !== null && Math.abs(((p.x - goal.point.x) * goal.normal.x + (p.y - goal.point.y) * goal.normal.y) / lengthM) < REFRESH_MIN_FACING_COS) return false;
  const steps = Math.ceil(lengthM / ACCESS_SAMPLE_STEP_M);
  for (let k = 0; k <= steps; k++) {
    const f = k / steps;
    if (lengthM * (1 - f) < 0.15) break;
    if (!pointInPolygon(p.x + (goal.point.x - p.x) * f, p.y + (goal.point.y - p.y) * f, room.polygon)) return false;
  }
  return true;
}

/*
 * return_to_base: only along a currently supported return route, and not while a guided person is still on the
 * way out (after-guidance section). Once every possible occupant has been guided and has left or arrived, with
 * no fire seen burning, the return is homeward (id suffix HOMEWARD_SUFFIX) and the local planner ranks it first.
 */

function returnCandidates(ctx: Ctx, notes: Note[]): ProposalCandidate[] {
  const walking = ctx.escorts.find(e => e.state === "en_route");
  if (walking !== undefined) {
    notes.push({ candidateId: null, text: `Not offering a return to base yet: guided occupant track ${label(walking.guidedId)} is still on the way out; the aircraft stands clear until the track has left or its arrival is confirmed.` });
    return [];
  }
  const home = homeward(ctx);
  return latestRoutes(ctx.belief.routes)
    .filter(route => route.purpose !== "evacuation" && route.status === "supported" && route.assessedTick >= ctx.now - ctx.policy.returnRouteFreshTicks && route.waypoints.length > 0)
    .sort((a, b) => a.estimatedDurationS - b.estimatedDurationS || compareText(a.id, b.id))
    .slice(0, MAX_RETURN_CANDIDATES)
    .map(route => {
      const why = home ? ` ${homewardReason(ctx)}` : "";
      const description = `Return to base along supported route ${label(route.id)} (about ${fmt(route.estimatedDurationS)} s, assessed ${ageText(ctx, route.assessedTick)} ago).${why}`;
      return build(ctx, {
        id: home ? candidateId("return_to_base", route.id, HOMEWARD_SUFFIX) : candidateId("return_to_base", route.id),
        tool: "return_to_base",
        description,
        rationale: `${description} ${sanitizeText(route.reason, 160)}`,
        target: target({ routeId: route.id, station: round3(route.waypoints[0]), focus: round3(route.waypoints[route.waypoints.length - 1]), evidenceTick: route.assessedTick }),
        action: { kind: "return", routeId: route.id },
        cited: cite(ctx, route.evidenceIds),
      });
    });
}

/* Non-proposal choices. */

function deferCandidate(gateReason: string | null): ChoiceCandidate {
  const why = gateReason === null ? "" : ` No mission action is currently supported: ${gateReason}.`;
  return { id: "defer", tool: "defer", description: clip(`Defer: keep the current goal and let the local planner or commander decide.${why}`, MAX_DESCRIPTION_LENGTH), target: null, proposal: null };
}

function humanReviewCandidate(): ChoiceCandidate {
  return { id: "request_human_review", tool: "request_human_review", description: "Ask the commander to review the evidence before any further mission action.", target: null, proposal: null };
}

/* Shared helpers. */

function build(ctx: Ctx, spec: CandidateSpec): ProposalCandidate {
  const lifetime = riskClassOf(spec.action.kind) === "consequential" ? ctx.policy.maxProposalLifetimeTicks : Math.min(ROUTINE_LIFETIME_TICKS, ctx.policy.maxProposalLifetimeTicks);
  const proposal: ProposalInput = {
    runId: ctx.belief.runId,
    aircraftId: ctx.profile.id,
    proposer: ctx.proposer,
    action: spec.action,
    rationale: clip(spec.rationale, MAX_RATIONALE_LENGTH),
    citedEvidence: spec.cited.slice(0, MAX_CITED),
    basis: ctx.basis,
    createdTick: ctx.now,
    expiresTick: ctx.now + lifetime,
  };
  return { id: spec.id, tool: spec.tool, description: clip(spec.description, MAX_DESCRIPTION_LENGTH), target: spec.target, proposal };
}

function target(fields: Partial<CandidateTarget>): CandidateTarget {
  return { roomId: null, trackId: null, openingId: null, routeId: null, station: null, focus: null, evidenceTick: null, access: null, ...fields };
}

function moveTo(ctx: Ctx, goal: Vec3): ActionSpec {
  return { kind: "move", goal, maxSpeedMps: ctx.speedMps };
}

function uniqueById(candidates: readonly ProposalCandidate[]): ProposalCandidate[] {
  const seen = new Set<string>();
  const unique: ProposalCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    unique.push(candidate);
  }
  return unique;
}

function freshFrom(ctx: Ctx): Tick {
  return ctx.now - ctx.policy.citedEvidenceMaxAgeTicks;
}

function interventionPoseSupported(ctx: Ctx): boolean {
  return ctx.belief.pose.supported && ctx.belief.pose.sigmaM <= ctx.policy.maxSigmaForInterventionM;
}

/** Inside the envelope with the current pose uncertainty as margin, as the harness checks it. */
function insideEnvelope(ctx: Ctx, p: Vec3): boolean {
  return envelopeContains(ctx.envelope, p, ctx.belief.pose.sigmaM);
}

function travelS(ctx: Ctx, goal: Vec3): number {
  return distance(ctx.pose, goal) / ctx.speedMps;
}

function keepsReserve(ctx: Ctx, durationS: number): boolean {
  return ctx.belief.aircraft.enduranceRemainingS - durationS >= ctx.profile.hardLimits.returnReserveS;
}

/** Any possible occupant (track or detection at or above the person threshold) within its uncertainty plus margin. */
function occupantNearRegion(ctx: Ctx, region: Region): boolean {
  return occupantNear(ctx, region) !== null;
}

interface BlockingOccupant {
  readonly what: string;
  readonly distanceM: number;
  readonly uncertaintyM: number;
}

/** The first possible occupant (tracks by id, then detections) within its uncertainty plus the person margin of the region, or null. */
function occupantNear(ctx: Ctx, region: Region): BlockingOccupant | null {
  const { personConfidenceThreshold, personMarginM } = ctx.policy;
  const near = (position: Vec3, uncertaintyM: number, confidence: number): number | null => {
    if (confidence < personConfidenceThreshold) return null;
    const d = distanceToRegion(region, position);
    return d <= uncertaintyM + personMarginM ? d : null;
  };
  for (const track of ctx.belief.tracks.filter(t => t.status === "possible").sort((a, b) => compareText(a.id, b.id))) {
    const d = near(track.position, track.uncertaintyM, track.confidence);
    if (d !== null) return { what: `possible-occupant track ${label(track.id)}`, distanceM: d, uncertaintyM: track.uncertaintyM };
  }
  for (const o of ctx.belief.observations) {
    for (const detection of o.detections) {
      if (detection.kind !== "possible_person") continue;
      const d = near(detection.position, detection.uncertaintyM, detection.confidence);
      if (d !== null) return { what: `a possible person in observation ${label(o.id)}`, distanceM: d, uncertaintyM: detection.uncertaintyM };
    }
  }
  return null;
}

function cite(ctx: Ctx, ids: readonly ObservationId[]): ObservationId[] {
  return [...new Set(ids)].filter(id => ctx.citable.has(id)).slice(-MAX_CITED);
}

function citableObservations(belief: BeliefSnapshot, from: Tick): Set<ObservationId> {
  const superseded = new Set(belief.observations.flatMap(o => (o.supersedes === null ? [] : [o.supersedes])));
  return new Set(belief.observations.filter(o => !superseded.has(o.id) && o.captureTick >= from).map(o => o.id));
}

/** Room hints of effective (not superseded) reports. A hint changes priority; it confirms nothing. */
export function reportedRooms(belief: BeliefSnapshot): Set<RoomId> {
  const superseded = new Set(belief.reports.flatMap(report => (report.supersedes === null ? [] : [report.supersedes])));
  return new Set(belief.reports.flatMap(report => (superseded.has(report.id) || report.roomHint === null ? [] : [report.roomHint])));
}

export function latestOpeningEvidence(openings: readonly OpeningEvidence[]): Map<OpeningId, OpeningEvidence> {
  const latest = new Map<OpeningId, OpeningEvidence>();
  for (const evidence of openings) {
    const current = latest.get(evidence.openingId);
    if (current === undefined || evidence.tick >= current.tick) latest.set(evidence.openingId, evidence);
  }
  return latest;
}

/** Latest assessment per route id (later entries win ties, as in the harness). */
export function latestRoutes(routes: readonly RouteAssessment[]): RouteAssessment[] {
  const latest = new Map<string, RouteAssessment>();
  for (const route of routes) {
    const current = latest.get(route.id);
    if (current === undefined || route.assessedTick >= current.assessedTick) latest.set(route.id, route);
  }
  return [...latest.values()];
}

/**
 * Exterior openings whose latest observation, at or after `from`, shows them open or broken. These are
 * observed entries; the planner prefers them to breaking glass.
 */
export function observedOpenEntries(belief: BeliefSnapshot, latest: ReadonlyMap<OpeningId, OpeningEvidence>, from: Tick): PriorOpening[] {
  return belief.mapPrior.openings.filter(opening => opening.rooms[1] === "exterior" && isObservedOpen(latest.get(opening.id), from));
}

function isObservedOpen(evidence: OpeningEvidence | undefined, from: Tick): boolean {
  return evidence !== undefined && (evidence.state === "open" || evidence.state === "broken") && evidence.tick >= from;
}

function roomInteriorPoint(room: PriorRoom): Vec3 | null {
  try {
    return round3(representativePoint(prism(room.polygon, room.zMin, room.zMax)));
  } catch {
    return null;
  }
}

function horizontalUnit(v: Vec3): Vec3 | null {
  const n = Math.hypot(v.x, v.y);
  return n > 1e-9 && Number.isFinite(n) ? vec3(v.x / n, v.y / n, 0) : null;
}

function round3(v: Vec3): Vec3 {
  return vec3(roundTo(v.x, 1000), roundTo(v.y, 1000), roundTo(v.z, 1000));
}

function roundTo(value: number, factor: number): number {
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roomLabel(room: PriorRoom): string {
  const name = sanitizeText(room.name, 48);
  return name.length > 0 ? name : label(room.id);
}

/** An identifier or name rendered for plain-language text: no control characters, bounded length. */
function label(text: string): string {
  return sanitizeText(text, 40);
}

function fmt(value: number): string {
  return String(roundTo(value, 100));
}

function ageText(ctx: Ctx, tick: Tick): string {
  return `${fmt(Math.max(0, ctx.now - tick) * TICK_S)} s`;
}
