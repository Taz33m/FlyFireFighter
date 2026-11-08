/**
 * The evidence store: the only writer of the truth-free BeliefSnapshot that planners and the harness read.
 *
 * Inputs are observations, caller/crew reports, crew confirmations, route assessments, map corrections and
 * the commander's dispatch fact. Each accepted input increments `evidenceRevision`; a rejected input changes
 * nothing. Every stored record is a frozen copy, so snapshots never alias caller objects or later state.
 *
 * Clock contract: ingest each input when it becomes available (an observation at its arrivalTick) and take
 * snapshots at non-decreasing ticks no earlier than any accepted input. Latest-state facts use capture time,
 * so late and out-of-order observations are safe. Pass the current tick to `ingestObservation` so an input
 * dated after it (a clock glitch) is rejected instead of wedging every later snapshot; snapshot inputs (pose,
 * aircraft status, landing support) are validated and a non-finite or out-of-range estimate is rejected.
 *
 * Labelling: `provenance` says where a frame came from (the twin's sensor model, an authored fixture or a
 * replayed recording); each possible-person detection's `method` says how a person was found. Twin frames
 * carry "oracle_fixture" person detections (a raycast against the hidden person): the method, not the
 * provenance, marks them as fixtures, and accounts must show it. A recording has no hidden truth to raycast,
 * so a "recording" frame with an "oracle_fixture" person search is rejected as inconsistent.
 *
 * Supersession (see supersession.ts) is reprocessing: the replacement must name a known observation from the
 * same sensor and frame, captured no later, not already superseded. The original's opening and hazard facts
 * are withdrawn in favour of the replacement's. Possible-occupant tracks keep both frames' detections: a
 * re-processed frame never erases a possible occupant.
 */
import type { Tick } from "../contracts/clock.ts";
import { isTick } from "../contracts/clock.ts";
import type {
  AircraftStatusEstimate,
  BeliefSnapshot,
  CallerReport,
  CrewConfirmation,
  EstimatedPose,
  LandingSupport,
  MapChange,
  RouteAssessment,
} from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import type { CommanderId, ObservationId, ReportId, RoomId, RouteId, TrackId } from "../contracts/ids.ts";
import { deepFreeze } from "../contracts/ids.ts";
import type { Observation } from "../contracts/observation.ts";
import { isFiniteVec3 } from "../contracts/frames.ts";
import type { Schema } from "../contracts/schema.ts";
import { validate } from "../contracts/schema.ts";
import type { EvidenceConfig } from "./config.ts";
import { configProblems } from "./config.ts";
import { CoverageGrid } from "./coverage.ts";
import { EvidenceRejection } from "./errors.ts";
import { LatestFacts } from "./facts.ts";
import { crewConfirmationSchema, mapChangeInputSchema, observationProblems, regionProblems, reportSchema, routeSchema } from "./schemas.ts";
import type { TrackChange, TrackCorrection } from "./tracks.ts";
import { TrackTable } from "./tracks.ts";
import { supersessionProblem } from "./supersession.ts";

export type IngestRejectionReason =
  | "other_run"
  | "duplicate_id"
  | "arrival_before_capture"
  /** The observation arrives (or was captured) after the `now` the caller passed. */
  | "from_future"
  /** `supersedes` does not name an earlier frame of the same sensor that is not already superseded. */
  | "invalid_supersession"
  | "invalid";

export type IngestResult =
  | {
      readonly accepted: true;
      readonly observationId: ObservationId;
      readonly evidenceRevision: number;
      /** One entry per possible_person detection at or above the track confidence threshold. */
      readonly tracks: readonly TrackChange[];
      /** Indices of possible_person detections below the track confidence threshold. */
      readonly ignoredDetections: readonly number[];
    }
  | { readonly accepted: false; readonly observationId: string | null; readonly reason: IngestRejectionReason; readonly detail: string };

export interface MapChangeInput {
  readonly tick: Tick;
  readonly region: Region;
  readonly reason: string;
  readonly observationIds: readonly ObservationId[];
}

export interface SnapshotInput {
  readonly tick: Tick;
  readonly pose: EstimatedPose;
  readonly aircraft: AircraftStatusEstimate;
  readonly landing: LandingSupport;
}

export class EvidenceStore {
  /** Frozen copy of the configuration. Nothing an input says can change it. */
  readonly config: EvidenceConfig;
  private revision = 0;
  private latestInputTick = 0;
  private lastSnapshotTick = -1;
  private readonly roomIds: ReadonlySet<RoomId>;
  private readonly observationIds = new Set<ObservationId>();
  /** What supersession checks need about every accepted observation, and which ones were superseded. */
  private readonly frames = new Map<ObservationId, FrameKey>();
  private readonly supersededBy = new Map<ObservationId, ObservationId>();
  private readonly window = new ObservationWindow();
  private readonly coverage: CoverageGrid;
  private readonly facts = new LatestFacts();
  private readonly tracks: TrackTable;
  private readonly reports: CallerReport[] = [];
  private readonly reportIds = new Set<ReportId>();
  private readonly confirmations: CrewConfirmation[] = [];
  private readonly confirmationIds = new Set<string>();
  private readonly routes = new Map<RouteId, RouteAssessment>();
  private readonly mapChanges: MapChange[] = [];
  private dispatch: { readonly by: CommanderId; readonly tick: Tick } | null = null;

  constructor(config: EvidenceConfig) {
    const problems = configProblems(config);
    if (problems.length > 0) throw new EvidenceRejection("invalid", `Invalid evidence configuration: ${problems.slice(0, 5).join("; ")}`);
    this.config = deepFreeze(structuredClone(config));
    const prior = this.config.mapPrior;
    this.roomIds = new Set(prior.rooms.map(room => room.id));
    this.coverage = new CoverageGrid(prior, this.config.coverageSpacingM, this.config.adequateQuality);
    this.tracks = new TrackTable({
      runId: this.config.runId,
      prior,
      associationGateMaxM: this.config.associationGateMaxM,
      occupantSpeedMps: this.config.occupantSpeedMps,
      minTrackConfidence: this.config.minTrackConfidence,
    });
  }

  get evidenceRevision(): number {
    return this.revision;
  }

  /** Prior revision plus the number of accepted map changes. */
  get mapRevision(): number {
    return this.config.mapPrior.revision + this.mapChanges.length;
  }

  /**
   * `now` is the caller's current mission tick; when given, an observation that arrives or was captured after
   * it is rejected ("from_future"). Callers should always pass it.
   */
  ingestObservation(observation: Observation, now?: Tick): IngestResult {
    const rejection = this.screen(observation, now);
    if (rejection !== null) return rejection;
    const stored = deepFreeze(structuredClone(observation));
    this.observationIds.add(stored.id);
    this.frames.set(stored.id, { id: stored.id, sensorId: stored.sensorId, frameId: stored.frameId, captureTick: stored.captureTick, supersedes: stored.supersedes });
    this.window.insert(stored);
    this.coverage.observe(stored);
    this.facts.record(stored);
    if (stored.supersedes !== null) {
      this.supersededBy.set(stored.supersedes, stored.id);
      this.facts.withdraw(stored.supersedes);
    }
    const { changes, ignored } = this.tracks.ingest(stored);
    this.accept(stored.arrivalTick);
    return deepFreeze({ accepted: true, observationId: stored.id, evidenceRevision: this.revision, tracks: changes, ignoredDetections: ignored });
  }

  /** Keeps the reporter's exact words. A correction names the report it supersedes, which is retained. */
  addReport(report: CallerReport): void {
    requireValid(reportSchema, report, "report");
    this.requireRun(report.runId, `Report ${report.id}`);
    if (this.reportIds.has(report.id)) throw new EvidenceRejection("duplicate_id", `Report ${report.id} was already added.`);
    if (report.supersedes !== null && !this.reportIds.has(report.supersedes)) {
      throw new EvidenceRejection("unknown_reference", `Report ${report.id} supersedes unknown report ${report.supersedes}.`);
    }
    this.requireRoom(report.roomHint, `Report ${report.id}`);
    this.reports.push(deepFreeze(structuredClone(report)));
    this.reportIds.add(report.id);
    this.accept(report.receivedTick);
  }

  /** Links crew evidence to tracks/reports. It never deletes, merges or resolves a track. */
  addCrewConfirmation(confirmation: CrewConfirmation): void {
    requireValid(crewConfirmationSchema, confirmation, "crew confirmation");
    const label = `Crew confirmation ${confirmation.id}`;
    if (this.confirmationIds.has(confirmation.id)) throw new EvidenceRejection("duplicate_id", `${label} was already added.`);
    if (confirmation.trackId !== null && this.tracks.get(confirmation.trackId) === undefined) {
      throw new EvidenceRejection("unknown_reference", `${label} links unknown track ${confirmation.trackId}.`);
    }
    const unknownReport = confirmation.reportIds.find(id => !this.reportIds.has(id));
    if (unknownReport !== undefined) throw new EvidenceRejection("unknown_reference", `${label} links unknown report ${unknownReport}.`);
    this.requireRoom(confirmation.roomId, label);
    this.confirmations.push(deepFreeze(structuredClone(confirmation)));
    this.confirmationIds.add(confirmation.id);
    this.accept(confirmation.tick);
  }

  /**
   * Records the current assessment of a route, replacing the previous one for the same id. An assessment older
   * than the held one never replaces it (returns false). "supported" must cite observations.
   */
  setRouteAssessment(route: RouteAssessment): boolean {
    requireValid(routeSchema, route, "route assessment");
    this.requireObservations(route.evidenceIds, `Route ${route.id}`);
    if (route.status === "supported" && route.evidenceIds.length === 0) {
      throw new EvidenceRejection("invalid", `Route ${route.id} cannot be supported without observation evidence.`);
    }
    const current = this.routes.get(route.id);
    if (current !== undefined && route.assessedTick < current.assessedTick) return false;
    this.routes.set(route.id, deepFreeze(structuredClone(route)));
    this.accept(route.assessedTick);
    return true;
  }

  addMapChange(change: MapChangeInput): MapChange {
    requireValid(mapChangeInputSchema, change, "map change");
    const regionIssues = regionProblems(change.region, "$.region");
    if (regionIssues.length > 0) throw new EvidenceRejection("invalid", `Invalid map change: ${regionIssues.join("; ")}`);
    this.requireObservations(change.observationIds, "Map change");
    const record: MapChange = deepFreeze({
      revision: this.mapRevision + 1,
      tick: change.tick,
      region: structuredClone(change.region),
      reason: change.reason,
      observationIds: [...change.observationIds],
    });
    this.mapChanges.push(record);
    this.accept(change.tick);
    return record;
  }

  /** The commander's explicit dispatch fact. The first entry stands; later calls change nothing (false). */
  confirmDispatch(by: CommanderId, tick: Tick): boolean {
    if (typeof by !== "string" || by.length === 0 || !isTick(tick)) throw new EvidenceRejection("invalid", "Dispatch confirmation needs a commander id and a tick.");
    if (this.dispatch !== null) return false;
    this.dispatch = deepFreeze({ by, tick });
    this.accept(tick);
    return true;
  }

  /** Explicit retraction with a reason. The track stays in every later snapshot with status "retracted". */
  retractTrack(trackId: TrackId, reason: string, tick: Tick): TrackCorrection {
    requireTick(tick, "Retraction");
    const correction = this.tracks.retract(trackId, reason, tick);
    this.accept(tick);
    return correction;
  }

  /** Explicit merge with a reason. Both tracks stay; the merged one has status "merged" and mergedInto. */
  mergeTracks(keepId: TrackId, mergedId: TrackId, reason: string, tick: Tick): TrackCorrection {
    requireTick(tick, "Merge");
    const correction = this.tracks.merge(keepId, mergedId, reason, tick);
    this.accept(tick);
    return correction;
  }

  /** Retractions and merges in the order they were made. BeliefSnapshot has no field for them yet. */
  trackCorrections(): readonly TrackCorrection[] {
    return this.tracks.corrections();
  }

  /** Throws EvidenceRejection "clock" for a bad tick and "invalid" for a malformed pose, aircraft or landing estimate. */
  snapshot(input: SnapshotInput): BeliefSnapshot {
    const tick = input.tick;
    if (!isTick(tick)) throw new EvidenceRejection("clock", `Snapshot tick ${tick} is not a mission tick.`);
    const estimateIssues = snapshotInputProblems(input);
    if (estimateIssues.length > 0) throw new EvidenceRejection("invalid", `Invalid snapshot input: ${estimateIssues.slice(0, 5).join("; ")}`);
    if (tick < this.lastSnapshotTick) throw new EvidenceRejection("clock", `Snapshot tick ${tick} precedes the previous snapshot at ${this.lastSnapshotTick}.`);
    if (tick < this.latestInputTick) {
      throw new EvidenceRejection("clock", `Snapshot tick ${tick} precedes accepted evidence at tick ${this.latestInputTick}; ingest inputs when they arrive.`);
    }
    this.lastSnapshotTick = tick;
    const windowStart = tick - this.config.observationWindowTicks;
    return deepFreeze({
      runId: this.config.runId,
      tick,
      evidenceRevision: this.revision,
      mapPrior: this.config.mapPrior,
      mapRevision: this.mapRevision,
      mapChanges: this.mapChanges.slice(),
      pose: copyPose(input.pose),
      aircraft: copyAircraft(input.aircraft),
      landing: copyLanding(input.landing),
      observations: this.window.since(windowStart),
      reports: this.reports.slice(),
      tracks: this.tracks.all(),
      crewConfirmations: this.confirmations.slice(),
      coverage: this.coverage.summary(),
      hazards: this.facts.hazardsSince(windowStart),
      openings: this.facts.openings(),
      routes: [...this.routes.values()],
      dispatchConfirmed: this.dispatch,
    });
  }

  private screen(observation: Observation, now: Tick | undefined): IngestResult | null {
    const candidate: unknown = observation;
    const record = typeof candidate === "object" && candidate !== null ? (candidate as Record<string, unknown>) : null;
    const observationId = typeof record?.id === "string" ? record.id : null;
    const reject = (reason: IngestRejectionReason, detail: string): IngestResult => deepFreeze({ accepted: false, observationId, reason, detail });
    if (record === null) return reject("invalid", "An observation must be an object.");
    if (record.runId !== this.config.runId) return reject("other_run", `Observation belongs to run ${String(record.runId)}, not ${this.config.runId}.`);
    if (observationId !== null && this.observationIds.has(observationId)) return reject("duplicate_id", `Observation ${observationId} was already accepted.`);
    const problems = observationProblems(candidate);
    if (problems.length > 0) return reject("invalid", problems.slice(0, 3).join("; "));
    if (observation.arrivalTick < observation.captureTick) {
      return reject("arrival_before_capture", `Observation ${observation.id} arrived at ${observation.arrivalTick}, before its capture at ${observation.captureTick}.`);
    }
    const problem = this.contextProblem(observation, now);
    return problem === null ? null : reject(problem[0], problem[1]);
  }

  /** Checks of a schema-valid observation against the clock, its labelling and the stored frames. */
  private contextProblem(observation: Observation, now: Tick | undefined): [IngestRejectionReason, string] | null {
    if (now !== undefined && !isTick(now)) return ["invalid", `The current tick ${String(now)} is not a mission tick.`];
    if (now !== undefined && observation.arrivalTick > now) return ["from_future", `Observation ${observation.id} arrives at tick ${observation.arrivalTick}, after the current tick ${now}.`];
    if (observation.provenance === "recording" && observation.personSearch === "oracle_fixture") {
      return ["invalid", `Observation ${observation.id} is a recording but claims an oracle_fixture person search; a recording has no hidden person to raycast.`];
    }
    if (observation.supersedes === null) return null;
    const problem = supersessionProblem(observation, this.frames.get(observation.supersedes));
    if (problem !== null) return ["invalid_supersession", problem];
    const earlier = this.supersededBy.get(observation.supersedes);
    return earlier === undefined ? null : ["invalid_supersession", `Observation ${observation.supersedes} was already superseded by ${earlier}; supersede ${earlier} instead.`];
  }

  private accept(tick: Tick): void {
    this.revision += 1;
    this.latestInputTick = Math.max(this.latestInputTick, tick);
  }

  private requireRun(runId: string, label: string): void {
    if (runId !== this.config.runId) throw new EvidenceRejection("other_run", `${label} belongs to run ${runId}, not ${this.config.runId}.`);
  }

  private requireRoom(roomId: RoomId | null, label: string): void {
    if (roomId !== null && !this.roomIds.has(roomId)) throw new EvidenceRejection("unknown_reference", `${label} names room ${roomId}, which is not in the floor-plan prior.`);
  }

  private requireObservations(ids: readonly ObservationId[], label: string): void {
    const unknown = ids.find(id => !this.observationIds.has(id));
    if (unknown !== undefined) throw new EvidenceRejection("unknown_reference", `${label} cites unknown observation ${unknown}.`);
  }
}

/**
 * Observations ordered by (captureTick, id), holding only those a future snapshot can still include.
 * Snapshot window starts never decrease, so anything captured before the last start is released.
 */
class ObservationWindow {
  private items: Observation[] = [];
  private start = -Infinity;

  insert(observation: Observation): void {
    if (observation.captureTick < this.start) return;
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (precedes(this.items[mid], observation)) low = mid + 1;
      else high = mid;
    }
    this.items.splice(low, 0, observation);
  }

  since(windowStart: Tick): Observation[] {
    if (windowStart > this.start) {
      this.start = windowStart;
      const firstKept = this.items.findIndex(item => item.captureTick >= windowStart);
      this.items = firstKept === -1 ? [] : this.items.slice(firstKept);
    }
    return this.items.slice();
  }
}

interface FrameKey {
  readonly id: ObservationId;
  readonly sensorId: string;
  readonly frameId: string | null;
  readonly captureTick: Tick;
  readonly supersedes: ObservationId | null;
}

/**
 * Every reason the estimates cannot enter a belief: non-finite numbers, negative uncertainties, endurance,
 * water or thrust, a pose stamped after the snapshot, or malformed landing support. Nothing is clamped: a
 * broken estimator must surface as an error, not as a plausible-looking belief.
 */
export function snapshotInputProblems(input: SnapshotInput): string[] {
  const problems: string[] = [];
  const need = (ok: boolean, message: string): void => {
    if (!ok) problems.push(message);
  };
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const nonNegative = (v: unknown): boolean => finite(v) && v >= 0;
  const finiteVec = (v: unknown): boolean => typeof v === "object" && v !== null && isFiniteVec3(v as Vec3);
  const { pose, aircraft, landing } = input;
  if (typeof pose !== "object" || pose === null) problems.push("pose must be an object");
  else {
    need(isTick(pose.tick) && pose.tick <= input.tick, `pose.tick ${String(pose.tick)} must be a mission tick no later than the snapshot tick ${input.tick}`);
    need(finiteVec(pose.position), "pose.position must be finite");
    need(finiteVec(pose.velocity), "pose.velocity must be finite");
    need(finite(pose.yawRad), `pose.yawRad ${String(pose.yawRad)} must be finite`);
    need(nonNegative(pose.sigmaM), `pose.sigmaM ${String(pose.sigmaM)} must be finite and >= 0`);
    need(nonNegative(pose.yawSigmaRad), `pose.yawSigmaRad ${String(pose.yawSigmaRad)} must be finite and >= 0`);
    need(typeof pose.supported === "boolean", "pose.supported must be a boolean");
  }
  if (typeof aircraft !== "object" || aircraft === null) problems.push("aircraft must be an object");
  else {
    need(nonNegative(aircraft.enduranceRemainingS), `aircraft.enduranceRemainingS ${String(aircraft.enduranceRemainingS)} must be finite and >= 0`);
    need(aircraft.waterRemainingL === null || nonNegative(aircraft.waterRemainingL), `aircraft.waterRemainingL ${String(aircraft.waterRemainingL)} must be null or finite and >= 0`);
    need(Array.isArray(aircraft.payloadsOnboard) && aircraft.payloadsOnboard.every(p => typeof p === "string"), "aircraft.payloadsOnboard must be a list of strings");
    need(aircraft.ambientC === null || (finite(aircraft.ambientC) && aircraft.ambientC >= -273.15), `aircraft.ambientC ${String(aircraft.ambientC)} must be null or a finite temperature`);
    need(nonNegative(aircraft.thrustAvailableN), `aircraft.thrustAvailableN ${String(aircraft.thrustAvailableN)} must be finite and >= 0`);
  }
  if (typeof landing !== "object" || landing === null) problems.push("landing must be an object");
  else {
    need(typeof landing.supported === "boolean", "landing.supported must be a boolean");
    need(landing.site === null || finiteVec(landing.site), "landing.site must be null or finite");
    need(!(landing.supported && landing.site === null), "supported landing needs a site");
    need(Array.isArray(landing.evidenceIds) && landing.evidenceIds.every(id => typeof id === "string"), "landing.evidenceIds must be a list of observation ids");
    need(typeof landing.reason === "string", "landing.reason must be text");
  }
  return problems;
}

function precedes(a: Observation, b: Observation): boolean {
  return a.captureTick < b.captureTick || (a.captureTick === b.captureTick && a.id < b.id);
}

function requireValid(schema: Schema, value: unknown, label: string): void {
  const errors = validate(schema, value);
  if (errors.length > 0) throw new EvidenceRejection("invalid", `Invalid ${label}: ${errors.slice(0, 3).join("; ")}`);
}

function requireTick(tick: Tick, label: string): void {
  if (!isTick(tick)) throw new EvidenceRejection("invalid", `${label} tick ${tick} is not a mission tick.`);
}

const copyVec = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

/** Copies only contract fields, so nothing extra on an estimator object can reach the belief. */
function copyPose(pose: EstimatedPose): EstimatedPose {
  return {
    tick: pose.tick,
    position: copyVec(pose.position),
    yawRad: pose.yawRad,
    velocity: copyVec(pose.velocity),
    sigmaM: pose.sigmaM,
    yawSigmaRad: pose.yawSigmaRad,
    supported: pose.supported,
  };
}

function copyAircraft(aircraft: AircraftStatusEstimate): AircraftStatusEstimate {
  return {
    enduranceRemainingS: aircraft.enduranceRemainingS,
    waterRemainingL: aircraft.waterRemainingL,
    payloadsOnboard: [...aircraft.payloadsOnboard],
    ambientC: aircraft.ambientC,
    thrustAvailableN: aircraft.thrustAvailableN,
  };
}

function copyLanding(landing: LandingSupport): LandingSupport {
  return { supported: landing.supported, site: landing.site === null ? null : copyVec(landing.site), evidenceIds: [...landing.evidenceIds], reason: landing.reason };
}
