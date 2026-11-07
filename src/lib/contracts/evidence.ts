/**
 * Evidence and belief: everything planners, the motion controller and the harness may know.
 *
 * BeliefSnapshot deliberately has no world-truth fields: no true poses, actor ids, fire cells or
 * occupant outcomes. Reports, possible-occupant tracks, crew confirmations and evaluator outcomes have
 * different provenance and are never merged into one "count". There is no room or house all-clear state:
 * coverage is `unobserved`, `observed` or `degraded`, and occupancy always remains unresolved.
 */
import type { Tick } from "./clock.ts";
import type { Vec3 } from "./frames.ts";
import type { Point2, Region } from "./geometry.ts";
import type { CommanderId, ObservationId, OpeningId, ReportId, RoomId, RouteId, RunId, TrackId } from "./ids.ts";
import type { HazardKind, Observation, OpeningState, SensorModality } from "./observation.ts";

/** The supplied floor plan: a prior with source and revision, not guaranteed current geometry. */
export interface FloorPlanPrior {
  readonly revision: number;
  readonly source: string;
  /** Floor indices increase upward from 0 (ground). elevationM and ceilingM are absolute world z values. */
  readonly floors: readonly { readonly index: number; readonly elevationM: number; readonly ceilingM: number }[];
  readonly rooms: readonly {
    readonly id: RoomId;
    readonly name: string;
    readonly floor: number;
    readonly polygon: readonly Point2[];
    readonly zMin: number;
    readonly zMax: number;
  }[];
  readonly openings: readonly {
    readonly id: OpeningId;
    readonly kind: "door" | "window" | "opening";
    readonly rooms: readonly [RoomId, RoomId | "exterior"];
    readonly center: Vec3;
    readonly widthM: number;
    readonly heightM: number;
    readonly outwardNormal: Vec3;
    readonly priorState: OpeningState | "unknown";
  }[];
  readonly exits: readonly { readonly id: string; readonly openingId: OpeningId }[];
  readonly assemblyPoint: Region;
  /** Stairs linking floors: the rooms containing each end and the walking line between them. */
  readonly stairs?: readonly {
    readonly id: string;
    readonly bottomRoomId: RoomId;
    readonly topRoomId: RoomId;
    readonly bottom: Vec3;
    readonly top: Vec3;
    readonly widthM: number;
  }[];
}

/** An observed correction to the prior ("plan says open hallway; lidar says blocked"). */
export interface MapChange {
  /** Map revision created by this change; current mapRevision = prior revision + number of changes. */
  readonly revision: number;
  readonly tick: Tick;
  readonly region: Region;
  readonly reason: string;
  readonly observationIds: readonly ObservationId[];
}

/** A report in the reporter's own words. Count language stays text; it is never arithmetic. */
export interface CallerReport {
  readonly id: ReportId;
  readonly runId: RunId;
  readonly receivedTick: Tick;
  readonly source: "caller" | "judge" | "crew_radio";
  readonly channel: "typed" | "voice";
  readonly originalText: string;
  readonly roomHint: RoomId | null;
  readonly countText: string | null;
  readonly interpretation: "rules" | "model" | "none";
  /** A correction or revision of an earlier report; the earlier report is retained. */
  readonly supersedes: ReportId | null;
}

/** A possible occupant inferred from detections. Not an identity and not a confirmed person. */
export interface OccupantTrack {
  readonly id: TrackId;
  readonly status: "possible" | "merged" | "retracted";
  readonly observationIds: readonly ObservationId[];
  readonly position: Vec3;
  readonly uncertaintyM: number;
  readonly roomId: RoomId | null;
  readonly firstSeenTick: Tick;
  readonly lastSeenTick: Tick;
  readonly confidence: number;
  readonly mergedInto: TrackId | null;
  /** Tracks that may be the same person; association is unresolved. */
  readonly ambiguousWith: readonly TrackId[];
}

/** Only crews write confirmations; they link to the reports/tracks they support. */
export interface CrewConfirmation {
  readonly id: string;
  readonly tick: Tick;
  readonly crewId: string;
  readonly trackId: TrackId | null;
  readonly reportIds: readonly ReportId[];
  readonly roomId: RoomId | null;
  readonly text: string;
}

/**
 * Fire class as the evidence indicates it (US letters; European in brackets): ordinary combustibles (A),
 * cooking oil or grease (K [F]), flammable liquid or gas (B), live electrical (C). "unknown" is the honest
 * default: no observation tells a flame's fuel apart, so a class comes only from reports, the floor-plan prior
 * and crew statements, and "ordinary" only from a crew statement.
 */
export type FireClass = "ordinary" | "cooking_oil" | "flammable_liquid" | "electrical" | "unknown";

/** Classes water must not be used on: it spreads burning oil and fuel and conducts on live wiring. */
export type WaterUnsafeFireClass = "cooking_oil" | "flammable_liquid" | "electrical";

/** report: a caller's or crew radio report; floor_plan_prior: a room type near the fire; crew: a crew confirmation. */
export type FireClassIndicatorSource = "report" | "floor_plan_prior" | "crew";

/** One piece of evidence that a fire may be of a class water is unsafe for. */
export interface FireClassIndicator {
  readonly fireClass: WaterUnsafeFireClass;
  readonly source: FireClassIndicatorSource;
  /** The report, room or crew confirmation id it came from. */
  readonly sourceId: string;
  /** The words that gave it, verbatim, or the prior room's name. */
  readonly cue: string;
  /** The room its source places it in, or null when the source names no single room (it then applies to every fire). */
  readonly roomId: RoomId | null;
  /** A crew statement that resolves it (the power isolated, ordinary combustibles confirmed), or null while it applies. */
  readonly resolvedBy: string | null;
  /** Plain language for the commander. */
  readonly text: string;
}

/** Whether water is a suitable agent for one observed fire, and the evidence for it. Derived from the belief, never from simulator truth. */
export interface FireClassAssessment {
  /** One water-unsafe class when every unresolved indicator agrees; "ordinary" only on a crew statement; otherwise "unknown". */
  readonly fireClass: FireClass;
  readonly indicators: readonly FireClassIndicator[];
  /** No unresolved water-unsafe indicator applies. This does not confirm the class: see fireClass. */
  readonly waterSuitable: boolean;
  /** Plain language for the commander, naming every indicator and its source. */
  readonly summary: string;
}

export type CoverageState = "unobserved" | "observed" | "degraded";

/**
 * One step of a room's person-search freshness profile: `fraction` of the room's sample points were last
 * covered by an adequate-quality person-search frame captured at or after `sinceTick`.
 */
export interface CoverageFreshnessStep {
  readonly sinceTick: Tick;
  readonly fraction: number;
}

/**
 * Coverage accumulated over the whole run. `state` is run-wide and never decays: a room is `observed` once
 * any sample point was covered at adequate quality by any modality, so it says nothing about how much of the
 * room was looked at or how recently. Decisions about searching or route support use the fractions and the
 * freshness profile instead.
 */
export interface RoomCoverage {
  readonly roomId: RoomId;
  readonly state: CoverageState;
  /** Fraction of the room's sample points observed at adequate quality (any modality, person search or not). */
  readonly fractionAdequate: number;
  /** Fraction observed at any quality. */
  readonly fractionAny: number;
  readonly lastObservedTick: Tick | null;
  readonly bestModality: SensorModality | null;
  /**
   * Fraction of the room's sample points covered at adequate quality by frames that ran a person search, at
   * any time in the run. Absent from beliefs built before it existed; consumers then fall back to
   * `fractionAdequate` only where over-counting is safe.
   */
  readonly fractionSearched?: number;
  /**
   * Person-search freshness profile, newest `sinceTick` first, fractions non-decreasing. To ask what fraction
   * was adequately person-searched at or after tick T, take the step with the smallest sinceTick >= T (0 when
   * none). The profile may be thinned, but every step is exact, so the answer is never an over-count (it may
   * under-count by at most 0.02). Absent means no freshness evidence (count as 0).
   */
  readonly searchedSince?: readonly CoverageFreshnessStep[];
}

export interface HazardEvidence {
  readonly observationId: ObservationId;
  readonly tick: Tick;
  readonly hazard: HazardKind;
  readonly region: Region;
  readonly intensity: number;
}

/** Latest observed state of an opening. */
export interface OpeningEvidence {
  readonly openingId: OpeningId;
  readonly state: OpeningState;
  readonly tick: Tick;
  readonly observationId: ObservationId;
}

/** A route judged from fresh observations. Suppression alone never makes a route supported. */
export interface RouteAssessment {
  readonly id: RouteId;
  readonly purpose: "return" | "alternate_return" | "evacuation";
  readonly waypoints: readonly Vec3[];
  readonly status: "supported" | "unsupported" | "unknown";
  readonly assessedTick: Tick;
  readonly evidenceIds: readonly ObservationId[];
  readonly estimatedDurationS: number;
  readonly reason: string;
}

/** Localization output from IMU and available visual/range measurements. */
export interface EstimatedPose {
  readonly tick: Tick;
  readonly position: Vec3;
  readonly yawRad: number;
  readonly velocity: Vec3;
  /** One-sigma horizontal position uncertainty. */
  readonly sigmaM: number;
  readonly yawSigmaRad: number;
  /** False when the estimator cannot support continued movement. */
  readonly supported: boolean;
}

/** Onboard telemetry: the aircraft's own instruments, not knowledge about the world. */
export interface AircraftStatusEstimate {
  readonly enduranceRemainingS: number;
  readonly waterRemainingL: number | null;
  readonly payloadsOnboard: readonly string[];
  readonly ambientC: number | null;
  readonly thrustAvailableN: number;
}

/** Whether a simulated landing is supported, e.g. downward ultrasound sees a flat surface. */
export interface LandingSupport {
  readonly supported: boolean;
  readonly site: Vec3 | null;
  readonly evidenceIds: readonly ObservationId[];
  readonly reason: string;
}

export interface BeliefSnapshot {
  readonly runId: RunId;
  readonly tick: Tick;
  /** Increments on every evidence change (observation, report, confirmation, route, map change). */
  readonly evidenceRevision: number;
  readonly mapPrior: FloorPlanPrior;
  readonly mapRevision: number;
  readonly mapChanges: readonly MapChange[];
  readonly pose: EstimatedPose;
  readonly aircraft: AircraftStatusEstimate;
  readonly landing: LandingSupport;
  /** Recent observations (bounded window) for coverage and revalidation queries. */
  readonly observations: readonly Observation[];
  readonly reports: readonly CallerReport[];
  readonly tracks: readonly OccupantTrack[];
  readonly crewConfirmations: readonly CrewConfirmation[];
  readonly coverage: readonly RoomCoverage[];
  readonly hazards: readonly HazardEvidence[];
  readonly openings: readonly OpeningEvidence[];
  readonly routes: readonly RouteAssessment[];
  /** Set only by an explicit commander fact entry; gates speech templates that mention dispatch. */
  readonly dispatchConfirmed: { readonly by: CommanderId; readonly tick: Tick } | null;
}
