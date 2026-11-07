/**
 * Harness policy and context.
 *
 * The policy holds the harness's own thresholds (it is revisioned; approvals bind to the revision). The
 * context is everything the harness may read on a tick: aircraft profile, policy, current mission
 * envelope and the truth-free belief snapshot. The harness never receives simulator truth.
 */
import type { ActionKind, RiskClass } from "../contracts/actions.ts";
import type { AircraftProfile } from "../contracts/aircraft.ts";
import type { Tick } from "../contracts/clock.ts";
import type { MissionEnvelope } from "../contracts/envelope.ts";
import type { BeliefSnapshot } from "../contracts/evidence.ts";
import { deepFreeze } from "../contracts/ids.ts";
import { PERSON_DETECTION_CONFIDENCE } from "../contracts/observation.ts";

export interface HarnessPolicy {
  readonly revision: number;
  /** Approval lifetime; execution must start before it ends. */
  readonly approvalTtlTicks: Tick;
  readonly maxProposalLifetimeTicks: Tick;
  /** Cited observations older than this cannot support a new execution. */
  readonly citedEvidenceMaxAgeTicks: Tick;
  /**
   * Age limit for the evidence behind an evacuation route (its rooms person-searched, its doors observed, fire
   * on its corridor), used by the route assessor and H15, and for the route evidence a guide cites. Longer than
   * citedEvidenceMaxAgeTicks because one aircraft must sweep the whole route (rooms on two floors and a stair,
   * about 20 m at indoor speeds) before the evidence can stand together; at 30 s no sweep could finish. The
   * route stays monitored every tick while guidance runs (H15 in the monitor phase), and the aircraft leads
   * along it, so a hazard seen on it stops the guidance.
   */
  readonly routeEvidenceMaxAgeTicks: Tick;
  /** Coverage of an affected region must be at least this recent at every check. */
  readonly coverageFreshTicks: Tick;
  /** Evacuation-route assessments older than this cannot support guidance. */
  readonly routeFreshTicks: Tick;
  readonly returnRouteFreshTicks: Tick;
  /**
   * Whole-frame quality below which a person-search frame supports no coverage at all (H6, the route assessor's
   * room views and fire re-looks, clearing a possible person by a later look). It rejects only frames unusable as
   * a whole. Where in a frame a person would have been detected is already the footprint's job: the sensors cut
   * each footprint ray where the person oracle's confidence for someone in view would fall below
   * PERSON_DETECTION_CONFIDENCE (contracts/observation.ts), counting smoke, range, glass and heat per point. A
   * frame-average bar set higher (it was 0.6) threw away the clear near field of every smoky frame because its
   * far field was obscured, while the old smoke-only cut still let the far edge claim space where nobody would
   * be detected. The simulated cameras report no exposure or blur failures, so the quality proxies (mean smoke
   * transmission for RGB, mean thermal contrast for thermal) stand in for them: below 0.3, most of the view is
   * lost and the frame is not trusted for absence anywhere. EVIDENCE_DEFAULTS.adequateQuality matches it.
   */
  readonly minCoverageQuality: number;
  /** Spray (and payload release): fraction of the affected region's required samples a fresh person search must cover (PRD: "supported coverage of the affected region"). */
  readonly minCoverageFraction: number;
  /**
   * Glass breach: the lower coverage fraction a breach needs. The PRD asks a breach for individual approval,
   * the exact target and affected region, fresh observations and explicit modeled effects — not the spray's
   * supported coverage — and no exterior vantage can see the fall volume under the sill or the wall beside
   * the frame inside. Measured with the aircraft's own cameras hovering at a standoff, 0.36–0.55 m out and up
   * to 0.45 m above the window centre, about 30% of an upstairs window's occupiable debris region stays out
   * of view (Troy study window 65–71%, fixture house 74%); ground-floor windows, with debris outside behind
   * the aircraft, reach about 50–60%. 65% therefore means the drone has looked through the pane at the room
   * behind it and at the ground below within the freshness window. The harness discloses where the unsearched
   * remainder lies, and any possible occupant near the region still blocks the breach outright.
   */
  readonly breachMinCoverageFraction: number;
  readonly coverageSpacingM: number;
  /**
   * Possible-person evidence at or above this confidence blocks interventions in its region. Footprints are cut
   * to PERSON_DETECTION_CONFIDENCE, so a policy may lower this but not raise it above that: H6 counts no
   * coverage at all under a higher threshold (coverageOf), because a footprint would then claim space where a
   * person could be reported below it.
   */
  readonly personConfidenceThreshold: number;
  /**
   * Detection blocking (H6): a possible-person detection or track blocks an intervention when it is within
   * its own uncertainty plus this margin of the affected region — even behind a wall (unclipped).
   */
  readonly personMarginM: number;
  /**
   * Coverage sampling (H6): the affected region plus this margin must have been searched for people. It is
   * deliberately smaller than personMarginM. The PRD requires supported coverage of the affected region
   * itself; a margin wide enough to hold a person put required samples beside and behind the aircraft and
   * under window sills, where no forward or downward camera can look, so every breach and spray was
   * refused. Someone outside this band who moves in is caught another way: monitoring re-checks detections
   * and tracks with personMarginM every executing tick and stops the action. The margin keeps a thin band of
   * edge samples so a footprint that ends exactly at the region boundary does not count as coverage.
   */
  readonly coverageMarginM: number;
  /**
   * Person clearance (H18 and the motion guard): the distance motion keeps from the aircraft's edge (half its
   * span) to a current possible occupant's estimated position, inflated by that track's or detection's own
   * uncertainty. A goal or route waypoint inside it is refused unless it is farther from the occupant than the
   * aircraft already is, and the motion guard removes any closing component that would cross it.
   */
  readonly personClearanceM: number;
  /** The larger person clearance kept while a guide executes: guidance leads from ahead and never closes in. */
  readonly guidanceClearanceM: number;
  /** A point outside every prior room but within this horizontal distance of one is wall, not open exterior. */
  readonly wallClearanceM: number;
  readonly maxSigmaForAdvanceM: number;
  readonly maxSigmaForInterventionM: number;
  readonly standoffToleranceM: number;
  readonly arrivalToleranceM: number;
  readonly envelopeLookaheadS: number;
  readonly stationKeepingSpeedMps: number;
  /**
   * The station-keeping speed cap while a spray discharges, instead of stationKeepingSpeedMps. Holding a
   * standoff against the jet's own reaction takes a velocity setpoint, not motion: the reaction ρQ²/A (3.2 N
   * for the Tender at 0.2 L/s) on a 2.2 kg aircraft whose velocity loop responds in about 0.2 s leaves a standing
   * error of about 0.2 × 3.2 / 2.2 ≈ 0.29 m/s that only the position hold cancels. Under the 0.2 m/s cap the hold
   * saturated and the aircraft crept off its standoff at about 0.06 m/s until H11 stopped the spray (main
   * mission: 0.405 and 0.409 m against the 0.4 m tolerance). The ground speed stays near zero: the cap bounds
   * the setpoint, and the jet pushes back. H11's tolerance is unchanged.
   */
  readonly sprayHoldSpeedMps: number;
  readonly maxHoldTicks: Tick;
  readonly guidanceAudioPeriodTicks: Tick;
  /** Descent rate of the unsupported terminal behavior when no supported maneuver remains. */
  readonly terminalDescentMps: number;
}

export const DEFAULT_POLICY: HarnessPolicy = deepFreeze({
  revision: 1,
  approvalTtlTicks: 2000,
  maxProposalLifetimeTicks: 6000,
  citedEvidenceMaxAgeTicks: 3000,
  routeEvidenceMaxAgeTicks: 6000,
  coverageFreshTicks: 200,
  routeFreshTicks: 500,
  returnRouteFreshTicks: 3000,
  minCoverageQuality: 0.3,
  minCoverageFraction: 0.95,
  breachMinCoverageFraction: 0.65,
  coverageSpacingM: 0.25,
  personConfidenceThreshold: PERSON_DETECTION_CONFIDENCE,
  personMarginM: 1.0,
  coverageMarginM: 0.3,
  personClearanceM: 1.0,
  guidanceClearanceM: 1.2,
  wallClearanceM: 0.4,
  maxSigmaForAdvanceM: 0.75,
  maxSigmaForInterventionM: 0.35,
  standoffToleranceM: 0.4,
  arrivalToleranceM: 0.3,
  envelopeLookaheadS: 0.5,
  stationKeepingSpeedMps: 0.2,
  sprayHoldSpeedMps: 0.35,
  maxHoldTicks: 3000,
  guidanceAudioPeriodTicks: 300,
  terminalDescentMps: 0.3,
});

export interface HarnessContext {
  readonly tick: Tick;
  readonly missionStartTick: Tick;
  readonly profile: AircraftProfile;
  readonly policy: HarnessPolicy;
  readonly envelope: MissionEnvelope;
  readonly belief: BeliefSnapshot;
}

/** Actions that change the world irreversibly; each needs its own commander approval. */
export const INTERVENTION_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>(["breach_opening", "spray", "release_payload"]);

/** Actions that own the aircraft's motion while executing (one at a time). */
export const MOTION_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>(["move", "scan", "hold", "return", "land", "guide"]);

/** Actions a contingency may use after a mission abort. */
export const CONTINGENCY_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>(["return", "hold", "land"]);

/** Risk is decided here, from the action kind alone; proposers cannot set or lower it. */
export function riskClassOf(kind: ActionKind): RiskClass {
  return INTERVENTION_KINDS.has(kind) ? "consequential" : "routine";
}
