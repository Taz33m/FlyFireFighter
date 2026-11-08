/**
 * Mission planning inside the runtime: when to plan, what to submit, and how an intervention reaches its
 * standoff. The decider (OpenAI Decisions or the local planner, via the DecisionBroker) only picks a
 * candidate; every proposal still goes through the harness, and the commander approves each intervention.
 *
 * - Plan when no motion action executes and no intervention is pending, at most every PLAN_PERIOD_TICKS; while
 *   moving, plan only on a relevant evidence change, and then only an intervention preempts the move.
 * - An intervention awaiting approval or approved gets a routine station move to its standoff (proposer
 *   local_planner, rationale naming the intervention). Once approved and on station it is executed.
 * - Rejected, expired, invalidated or refused candidates are left out for a cooling period so another
 *   option surfaces; a commander rejection cools longer. A size-up look at a window cools once its motion ends.
 * - A motion action that makes no progress for NO_PROGRESS_TICKS is stopped (abort of that proposal only)
 *   and its candidate cooled; its goal (or a standoff never reached) is marked unreachable (UnreachableMarks):
 *   candidates stationed within UNREACHABLE_RADIUS_M of it are left out for UNREACHABLE_TICKS, doubling with
 *   each repeated stall there and for the rest of the run from the UNREACHABLE_PERMANENT_AFTER-th (track ids
 *   churn, candidate ids alone do not stop loops). One stalled approach no longer rules out every nearby station.
 * - The station of the candidate chosen last is passed back to the candidate factory as its incumbent, so a
 *   re-plan keeps it while it stays valid and nothing is materially better (sighting jitter does not flip it);
 *   a refusal at submission drops it, and a station refused twice running for coverage alone is left out like
 *   a stalled goal so another standoff is tried. Marks in force are passed to the factory, which then chooses
 *   another station rather than the candidate disappearing. While a spray cools after a coverage refusal the
 *   factory offers no observation move away from its station. A second look at a lead cools once it reaches
 *   its viewpoint.
 * - Every guide that began executing is passed to the factory, which keeps the aircraft off the guided person's way
 *   out until the track has left or arrived (a guide ends on its time limit, not on arrival); the stand-clear look
 *   it offers never cools, and a running guide yields once the set offers the homeward return (guideYields).
 * - An intervention chosen while the aircraft is away from its station is not proposed yet: a routine
 *   "preposition" move takes the aircraft there, it dwells DWELL_TICKS looking at the affected region, and
 *   the next plan proposes it from the station. A refusal for missing fresh coverage alone (H6) is retried
 *   after another dwell instead of being cooled for long.
 * - While the aircraft holds a station with a focus (that dwell, and an intervention awaiting approval or
 *   approved on its station), a routine scan in place looking at the focus owns the motion, so the controller
 *   turns the forward cameras toward the affected region: the harness lets nothing move, not even a turn in
 *   place, without an executing motion action. The scan ends when its intervention executes or ends.
 */
import type { ActionProposal, ProposalInput, ProposalRecord } from "../contracts/actions.ts";
import { TERMINAL_STATUSES } from "../contracts/actions.ts";
import type { Tick } from "../contracts/clock.ts";
import type { EventLog } from "../contracts/events.ts";
import type { BeliefSnapshot } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance } from "../contracts/frames.ts";
import type { ProposalId } from "../contracts/ids.ts";
import type { ActionHarness } from "../harness/harness.ts";
import type { HarnessContext } from "../harness/policy.ts";
import { sprayDischarges } from "../harness/respray.ts";
import type { BrokerStep, DecisionRecord } from "../navigation/planner/broker.ts";
import type { DecisionBroker } from "../navigation/planner/broker.ts";
import { decisionEvent, discardEvent } from "../navigation/planner/broker.ts";
import type { GuidedTrack } from "../navigation/planner/candidates.ts";
import { buildCandidateSet, isHomeward, isReturnRefresh, isStandClear, isWindowLook, resolveCandidate } from "../navigation/planner/candidates.ts";
import { findFlightPath, spaceOf } from "./steering-graph.ts";
import type { CandidateSet, CandidateTarget } from "../navigation/planner/types.ts";

export const PLAN_PERIOD_TICKS = 50;
export const NO_PROGRESS_TICKS = 1500;
export const PROGRESS_STEP_M = 0.25;
export const COOL_REJECTED_TICKS = 3000;
export const COOL_INVALID_TICKS = 1000;
/** A size-up look at a window (candidates.ts isWindowLook) is offered again only this long after its motion ended. */
export const COOL_LOOK_TICKS = 18_000;
/**
 * Cooling after a refusal for missing fresh coverage only: it ends with the dwell that follows (DWELL_TICKS),
 * so the next plan retries from the station. At 250 ticks the plan after a 150-tick dwell found the spray still
 * cooling, chose a second look at the lead instead, and the aircraft left the station.
 */
export const COOL_COVERAGE_TICKS = 30;
/** Dwell on station (no planning) so person-search coverage of the affected region builds up. */
export const DWELL_TICKS = 30;
/** An intervention is proposed only once the aircraft faces its focus within this (its cameras search the region). */
export const FACE_TOLERANCE_RAD = (10 * Math.PI) / 180;
/** Planning pause per wait for the turn to finish, and the most waits per candidate before proposing anyway. */
export const FACE_WAIT_TICKS = 25;
export const MAX_FACE_WAITS = 3;

/** What an intervention acts on: a spray's aim, a breach's strike point, a release point. */
function actionFocus(action: ProposalInput["action"]): Vec3 | null {
  if (action.kind === "spray") return action.aimPoint;
  if (action.kind === "breach_opening") return action.strikePoint;
  if (action.kind === "release_payload") return action.releasePoint;
  return null;
}

/** Horizontal angle between the aircraft's heading and the bearing to `focus`; null without a focus or when it is overhead. */
export function facingErrorRad(pose: { readonly position: Vec3; readonly yawRad: number }, focus: Vec3 | null): number | null {
  if (focus === null) return null;
  const dx = focus.x - pose.position.x;
  const dy = focus.y - pose.position.y;
  if (Math.hypot(dx, dy) < 0.2) return null;
  const diff = Math.atan2(dy, dx) - pose.yawRad;
  return Math.abs(Math.atan2(Math.sin(diff), Math.cos(diff)));
}

/** Length of the scan facing an intervention's focus while it waits on its station; renewed while it waits. */
export const HOLD_SCAN_TICKS = 1000;
/**
 * A breach is proposed directly when the aircraft is this close to its standoff; else it prepositions (its
 * station move then docks at the pane). Inside the harness's standoff tolerance (H11, 0.4 m) on purpose:
 * coverage is judged at submission from where the aircraft is, so it must already be where it will act.
 */
export const PREPOSITION_NEAR_M = 0.35;
/**
 * Station hysteresis for every other intervention (a spray): it is on its station within the harness's
 * standoff tolerance less ON_STATION_MARGIN_M (0.35 m by default), and is proposed only within that less
 * PROPOSE_MARGIN_M (0.32 m: a preposition move ends within 0.30 m, plus a little drift during the dwell, so
 * arrival and proposing do not ping-pong). A proposed spray is therefore always on station,
 * and settling or jitter of a few centimetres starts no station move. At a propose distance of 0.35 m with
 * on-station at 0.30 m, a spray accepted 0.32 m off was never ready: a station move started every few ticks,
 * each ended at once, and three of them aborted it.
 */
export const ON_STATION_MARGIN_M = 0.05;
export const PROPOSE_MARGIN_M = 0.03;
/** A routine move keeps going while the newest set offers its candidate's station within this distance. */
export const STILL_OFFERED_M = 0.3;
/** After a station move ends, the next one waits this long (a time guard: attempts never burn per tick). */
export const STATION_RETRY_TICKS = 100;
/** Candidates stationed this close to a goal that stalled are left out while its mark lasts. */
export const UNREACHABLE_RADIUS_M = 0.3;
/** How long a stalled goal's first mark lasts (60 s); each repeated stall at the same point doubles it. */
export const UNREACHABLE_TICKS = 6000;
/** The stall at the same point that makes its mark last for the rest of the run. */
export const UNREACHABLE_PERMANENT_AFTER = 3;
/** A completed second look at a lead (investigate_signal) is not offered again for one track-recheck period. */
export const COOL_SECOND_LOOK_TICKS = 1500;
/**
 * A station refused for coverage alone this many times running is left out like a stalled goal (an
 * UnreachableMarks mark), so the next plan tries another standoff instead of looking again from the same spot.
 */
export const AVOID_AFTER_COVERAGE_REFUSALS = 2;
/** Refusals count toward AVOID_AFTER_COVERAGE_REFUSALS for the same station only within this distance (sighting jitter, not a different standoff). */
export const SAME_STATION_M = 0.1;
/** The station of the candidate chosen last is offered back as its incumbent for this long after that choice. */
export const INCUMBENT_TICKS = 3000;
export const RUNTIME_ACTOR = "mission-runtime";
/** A breach executes only with the estimated strike distance this far inside the breaker's reach. */
export const STRIKE_MARGIN_M = 0.08;
/** Station-move goal distance from a breach's strike point. */
export const BREACH_DOCK_M = 0.05;
const ROUTINE_LIFETIME_TICKS = 1000;
const MAX_STATION_ATTEMPTS = 3;
/** Motion actions that must keep getting closer to their goal (hold, scan and guide wait by design). */
const PROGRESS_KINDS: ReadonlySet<string> = new Set(["move", "return", "land"]);

export interface ProposalMeta {
  readonly candidateId: string | null;
  readonly focus: Vec3 | null;
  readonly station: Vec3 | null;
  /** "dwell": a scan in place facing the focus while the aircraft holds a station. */
  readonly role: "candidate" | "station" | "preposition" | "dwell" | "contingency";
}

export interface PlannerTick {
  readonly ctx: HarnessContext;
  readonly harness: ActionHarness;
  readonly log: EventLog;
  readonly lastInterventionTick: Tick | null;
  readonly nowMs: number;
}

/** Hands planning sets to a remote decider and receives its steps later (cloud mode). */
export interface RemoteDecider {
  plan(set: CandidateSet, belief: BeliefSnapshot): void;
}

export class MissionPlanner {
  readonly broker: DecisionBroker;
  readonly meta = new Map<ProposalId, ProposalMeta>();
  private readonly cooling = new Map<string, Tick>();
  private readonly inbox: BrokerStep[] = [];
  private remote: RemoteDecider | null = null;
  private lastPlanTick = -Infinity;
  private lastSignature = "";
  private focusId: ProposalId | null = null;
  private stationId: ProposalId | null = null;
  /** Station moves for the focus that ended without the aircraft on station (see MAX_STATION_ATTEMPTS). */
  private stationAttempts = 0;
  /** No station move starts before this tick (STATION_RETRY_TICKS after the last one ended). */
  private stationRetryTick = -Infinity;
  private progress: { id: ProposalId; waypoint: Vec3 | null; best: number; since: Tick } | null = null;
  /**
   * The look being flown: a size-up look at a window cools when its motion ends however it ends; a second look
   * at a lead cools when it completes. Replans during it still offer it.
   */
  private look: { readonly proposalId: ProposalId; readonly candidateId: string; readonly kind: "window" | "lead" } | null = null;
  private lastSet: CandidateSet | null = null;
  /** Goals that stopped making progress: candidates stationed near them are left out while their marks last. */
  readonly unreachable = new UnreachableMarks();
  /** Candidates cooling after a coverage refusal, to be retried from their station: until when (see candidates.ts retrying). */
  private readonly coverageRetry = new Map<string, Tick>();
  /** Coverage-only refusals counted per station (see AVOID_AFTER_COVERAGE_REFUSALS). */
  private coverageRefusals: { readonly point: Vec3; readonly count: number }[] = [];
  /** The station of the candidate chosen last (see INCUMBENT_TICKS). */
  private incumbent: { readonly candidateId: string; readonly station: Vec3; readonly tick: Tick } | null = null;
  /** No planning before this tick: dwell on station so fresh person-search coverage builds up. */
  private dwellUntil = -Infinity;
  private readonly dwelled = new Set<ProposalId>();
  /** Waits for the turn toward the focus before proposing, per candidate. */
  private readonly faceWaits = new Map<string, number>();
  /** The scan facing the focus while holding a station, and no new one before dwellRetryTick after a refusal. */
  private dwellScanId: ProposalId | null = null;
  private dwellRetryTick = -Infinity;
  lastDecision: DecisionRecord | null = null;

  constructor(broker: DecisionBroker) {
    this.broker = broker;
  }

  /** Cloud mode: sets go to this decider; its steps come back through receive(). */
  useRemote(remote: RemoteDecider | null): void {
    this.remote = remote;
  }

  /** A broker step from the remote loop; applied at the next tick boundary. */
  receive(step: BrokerStep): void {
    this.inbox.push(step);
  }

  /** The intervention the planner is currently working toward (pending, approved or executing). */
  get focus(): ProposalId | null {
    return this.focusId;
  }

  tick(t: PlannerTick): void {
    for (const step of this.inbox.splice(0)) this.handleStep(step, t);
    this.endLook(t);
    this.manageFocus(t);
    if (this.shouldPlan(t)) this.plan(t);
  }

  /** Called with the steering's remaining distance each tick; stops a motion action that stopped progressing. */
  watch(t: PlannerTick, remainingM: number | null): void {
    const active = t.harness.activeMotion();
    // Contingencies belong to the harness, which bounds and reselects them; aborting one here only restarts it.
    if (!active || remainingM === null || !PROGRESS_KINDS.has(active.proposal.action.kind) || active.proposal.proposer === "contingency") {
      this.progress = null;
      return;
    }
    const id = active.proposal.id;
    if (this.progressed(id, active.goal, remainingM, t.ctx.tick)) return;
    if (t.ctx.tick - (this.progress?.since ?? t.ctx.tick) < NO_PROGRESS_TICKS) return;
    this.progress = null;
    const goal = active.goal ?? this.meta.get(id)?.station ?? null;
    if (goal !== null) this.markUnreachable(goal, t, `no progress for ${NO_PROGRESS_TICKS} ticks`);
    t.harness.abort({ type: "abort", runId: t.harness.runId, scope: id, by: RUNTIME_ACTOR, tick: t.ctx.tick, reason: `no progress toward the goal for ${NO_PROGRESS_TICKS} ticks (${remainingM.toFixed(2)} m remaining)` }, t.ctx);
    this.cool(this.meta.get(id)?.candidateId ?? null, t.ctx.tick + COOL_INVALID_TICKS);
    this.lastPlanTick = -Infinity;
  }

  /** Updates the progress baseline; true when it was restarted or improved, so no stall can be declared yet. */
  private progressed(id: ProposalId, waypoint: Vec3 | null, remainingM: number, tick: Tick): boolean {
    const progress = this.progress;
    // A route action's goal is its current waypoint, which the harness advances as each is reached; distances to
    // the next one are not comparable with the best to the last, so a new waypoint restarts the baseline. Compared
    // horizontally: a floating waypoint's height follows the aircraft.
    const last = progress?.waypoint ?? null;
    const advanced = waypoint !== null && last !== null && Math.hypot(waypoint.x - last.x, waypoint.y - last.y) > PROGRESS_STEP_M;
    // A new move's first reading may still be the previous goal's remaining distance (the controller runs on
    // even ticks), so the baseline starts unset and the next reading becomes it.
    if (progress === null || progress.id !== id || advanced) {
      this.progress = { id, waypoint, best: Infinity, since: tick };
      return true;
    }
    if (remainingM < progress.best - PROGRESS_STEP_M) {
      this.progress = { id, waypoint, best: remainingM, since: tick };
      return true;
    }
    return false;
  }

  /* Planning. */

  private shouldPlan(t: PlannerTick): boolean {
    if (this.focusId !== null || t.harness.missionAborted) return false;
    if (t.ctx.tick - this.lastPlanTick < PLAN_PERIOD_TICKS || t.ctx.tick < this.dwellUntil) return false;
    const active = t.harness.activeMotion();
    if (active === null) return true;
    if (this.meta.get(active.proposal.id)?.role !== "candidate") return false;
    return relevantSignature(t.ctx.belief) !== this.lastSignature;
  }

  private plan(t: PlannerTick): void {
    const { ctx } = t;
    this.lastPlanTick = ctx.tick;
    this.lastSignature = relevantSignature(ctx.belief);
    const omit = [...this.cooling.entries()].filter(([, until]) => until > ctx.tick).map(([id]) => id);
    const incumbent = this.incumbent !== null && ctx.tick - this.incumbent.tick <= INCUMBENT_TICKS ? { candidateId: this.incumbent.candidateId, station: this.incumbent.station } : null;
    const avoid = this.unreachable.active(ctx.tick);
    const retrying = [...this.coverageRetry.entries()].filter(([, until]) => until > ctx.tick).map(([id]) => id);
    // Stations are chosen among those the aircraft can fly to now (the same test the filter below applies).
    const reachable = (station: Vec3) => !this.unreachable.has(station, ctx.tick) && flightPathExists(ctx, station);
    // Guided people walk out after their guide ends; the factory keeps the aircraft off their way out.
    const guided = guidedTracks(t.harness.records());
    // Sprays that put water out: no further spray at a fire one reached until a later sighting still shows flame.
    const sprays = sprayDischarges(t.harness.records());
    const build = (omitted: readonly string[]) => buildCandidateSet({ belief: ctx.belief, profile: ctx.profile, envelope: ctx.envelope, policy: ctx.policy, lastInterventionTick: t.lastInterventionTick, omitCandidateIds: omitted, proposer: "local_planner", incumbent, avoid, retrying, reachable, guided, sprays });
    let set = build(omit);
    const blocked = set.candidates.filter(c => c.target?.station != null && (this.unreachable.has(c.target.station, ctx.tick) || !flightPathExists(ctx, c.target.station))).map(c => c.id);
    if (blocked.length > 0) set = build([...omit, ...blocked]);
    this.lastSet = set;
    if (this.remote !== null && this.broker.cloudActive) this.remote.plan(set, ctx.belief);
    else this.handleStep(this.broker.plan(set, ctx.belief, t.nowMs), t);
  }

  private handleStep(step: BrokerStep, t: PlannerTick): void {
    for (const discarded of step.discarded) t.log.append(discardEvent(discarded, t.ctx.tick));
    for (const record of step.decisions) this.decide(record, t);
  }

  private decide(record: DecisionRecord, t: PlannerTick): void {
    if (record.runId !== t.harness.runId) return;
    t.log.append(decisionEvent(record, t.ctx.tick));
    this.lastDecision = record;
    if (record.proposal === null || this.focusId !== null || t.harness.missionAborted) return;
    const target = this.targetOf(record.candidateId);
    const meta: ProposalMeta = { candidateId: record.candidateId, focus: target?.focus ?? null, station: target?.station ?? null, role: "candidate" };
    if (record.requiresCommanderApproval) {
      this.keepStation(meta, t);
      this.proposeFromStation(record.proposal, meta, t);
      return;
    }
    // A routine choice never preempts a move already under way; the planner returns to it on arrival. A move to a
    // station re-planning no longer offers (a possible occupant now makes it unsafe, say) is stopped instead.
    const active = t.harness.activeMotion();
    if (active !== null && !this.stillOffered(active.proposal.id)) this.stopMotion(active.proposal, "re-planning no longer offers its station", t);
    if (t.harness.activeMotion() !== null) return;
    const started = this.start(record.proposal, meta, t);
    if (started === null) return;
    this.keepStation(meta, t);
    this.trackLook(started, record);
  }

  /**
   * Remember a started size-up look at a window or second look at a lead, for cooling when it ends (endLook). A
   * stand-clear look at a guided person is not a second look: it holds until they have left, so it never cools.
   */
  private trackLook(proposalId: ProposalId, record: DecisionRecord): void {
    if (this.isWindowLook(record.candidateId)) this.look = { proposalId, candidateId: record.candidateId, kind: "window" };
    else if (record.tool === "investigate_signal" && !this.isStandClear(record.candidateId)) this.look = { proposalId, candidateId: record.candidateId, kind: "lead" };
  }

  /** Remember the chosen candidate's station as the incumbent for the next plans. */
  private keepStation(meta: ProposalMeta, t: PlannerTick): void {
    if (meta.candidateId !== null && meta.station !== null) this.incumbent = { candidateId: meta.candidateId, station: meta.station, tick: t.ctx.tick };
  }

  /**
   * One size-up look per window per cooling period: once the look's motion ends (arrived, stopped or
   * aborted) it cools. The approach itself faces the pane, so a look that did not resolve its state is not
   * repeated at once. A second look at a lead that reached its viewpoint cools for COOL_SECOND_LOOK_TICKS, so
   * the planner does not circle the lead while other work (the fire) waits.
   */
  private endLook(t: PlannerTick): void {
    const look = this.look;
    if (look === null) return;
    const record = t.harness.record(look.proposalId);
    if (record !== null && !TERMINAL_STATUSES.includes(record.status)) return;
    // Demo: a window look cools once it arrived (its pane was seen); one stopped on the way may be offered again.
    if (look.kind === "window" && record?.status === "completed") this.cool(look.candidateId, t.ctx.tick + COOL_LOOK_TICKS);
    else if (record?.status === "completed") this.cool(look.candidateId, t.ctx.tick + COOL_SECOND_LOOK_TICKS);
    this.look = null;
  }

  /** Whether the active motion's candidate is still offered at the same station by the newest set (non-candidate motion counts as offered). */
  private stillOffered(proposalId: ProposalId): boolean {
    const meta = this.meta.get(proposalId);
    if (meta === undefined || meta.role !== "candidate" || meta.candidateId === null || meta.station === null || this.lastSet === null) return true;
    // Guidance leads a moving person, so its target moves with them; the harness monitors its route (H15). It runs
    // on its time limit, not to arrival, so it yields once every guided person is out (guideYields).
    if (meta.candidateId.startsWith("guide_to_exit:")) return !guideYields(this.lastSet);
    // A return follows its route, whose start moves with the aircraft as the route is reassessed: it continues
    // while the set still offers it (in the main run a replan on a new track restarted it at the front door).
    if (meta.candidateId.startsWith("return_to_base:")) return resolveCandidate(this.lastSet, meta.candidateId) !== null;
    const station = resolveCandidate(this.lastSet, meta.candidateId)?.target?.station ?? null;
    return station !== null && distance(station, meta.station) <= STILL_OFFERED_M;
  }

  private isWindowLook(candidateId: string): boolean {
    const candidate = this.lastSet === null ? null : resolveCandidate(this.lastSet, candidateId);
    return candidate !== null && isWindowLook(candidate);
  }

  private isStandClear(candidateId: string): boolean {
    const candidate = this.lastSet === null ? null : resolveCandidate(this.lastSet, candidateId);
    return candidate !== null && isStandClear(candidate);
  }

  /** Submit an intervention for the commander; it becomes the focus and a candidate move in progress yields to it. */
  private propose(input: ProposalInput, meta: ProposalMeta, t: PlannerTick): void {
    const submitted = t.harness.submit(input, t.ctx);
    if (!submitted.accepted || submitted.proposalId === null) {
      // A station the harness just refused from is no longer one to hold on to: the next plan chooses afresh.
      if (this.incumbent?.candidateId === meta.candidateId) this.incumbent = null;
      const coverageOnly = coverageOnlyFindings(submitted.findings);
      this.cool(meta.candidateId, t.ctx.tick + (coverageOnly ? COOL_COVERAGE_TICKS : COOL_INVALID_TICKS));
      if (coverageOnly) this.afterCoverageRefusal(meta, t);
      return;
    }
    if (meta.station !== null) this.coverageRefusals = this.coverageRefusals.filter(r => distance(r.point, meta.station as Vec3) > SAME_STATION_M);
    this.meta.set(submitted.proposalId, meta);
    this.focusId = submitted.proposalId;
    this.stationAttempts = 0;
    this.stationRetryTick = -Infinity;
    const active = t.harness.activeMotion();
    if (active !== null && this.meta.get(active.proposal.id)?.role === "candidate") this.stopMotion(active.proposal, `superseded by intervention ${submitted.proposalId} awaiting the commander`, t);
  }

  /** Submit and execute a routine proposal; a refusal cools its candidate. */
  private start(input: ProposalInput, meta: ProposalMeta, t: PlannerTick): ProposalId | null {
    const submitted = t.harness.submit(input, t.ctx);
    if (submitted.proposalId !== null) this.meta.set(submitted.proposalId, meta);
    if (!submitted.accepted || submitted.proposalId === null || submitted.digest === null) {
      this.cool(meta.candidateId, t.ctx.tick + COOL_INVALID_TICKS);
      return null;
    }
    const executed = t.harness.requestExecution({ type: "execute", runId: t.harness.runId, proposalId: submitted.proposalId, digest: submitted.digest, requestId: `${submitted.proposalId}#run`, tick: t.ctx.tick }, t.ctx);
    if (!executed.accepted) this.cool(meta.candidateId, t.ctx.tick + COOL_INVALID_TICKS);
    return executed.accepted ? submitted.proposalId : null;
  }

  /* Interventions: station moves, execution and their ends. */

  private manageFocus(t: PlannerTick): void {
    if (this.focusId === null) return;
    const record = t.harness.record(this.focusId);
    if (record === null || TERMINAL_STATUSES.includes(record.status)) return this.endFocus(record, t);
    if (record.status === "executing") return this.endDwell(`${record.proposal.action.kind} proposal ${record.proposal.id} is executing and holds the station itself`, t);
    const station = stationGoal(record.proposal, t.ctx.profile.modules.glassBreaker?.reachM ?? 0);
    const ready = onStation(record.proposal, t.ctx);
    if (record.status === "approved" && ready && record.approval !== null) {
      t.harness.requestExecution({ type: "execute", runId: t.harness.runId, proposalId: record.proposal.id, digest: record.proposal.digest, requestId: `${record.proposal.id}#run`, tick: t.ctx.tick }, t.ctx);
      return;
    }
    if (!ready && station !== null) this.ensureStationMove(record, station, t);
    else if (ready) {
      if (record.proposal.action.kind !== "breach_opening") this.stationReached(t);
      this.faceFocus(interventionFocus(record.proposal, this.meta.get(record.proposal.id)), HOLD_SCAN_TICKS, `the affected region of ${record.proposal.action.kind} proposal ${record.proposal.id} while it ${record.status === "approved" ? "is approved" : "awaits the commander"}`, t);
    }
  }

  /**
   * On station already (within onStationM) while a station move still runs toward the harness's tighter arrival
   * tolerance: end it, uncounted, so the scan facing the focus takes over instead of the move stalling there.
   */
  private stationReached(t: PlannerTick): void {
    if (this.stationId === null) return;
    const active = t.harness.activeMotion();
    if (active !== null && active.proposal.id === this.stationId) this.stopMotion(active.proposal, "the aircraft is on its station", t);
    this.stationId = null;
  }

  /**
   * Start a routine scan in place looking at `focus` (the harness turns nothing without an executing motion
   * action). No-op without a focus, while another motion action executes, or shortly after a refused scan.
   */
  private faceFocus(focus: Vec3 | null, durationTicks: Tick, what: string, t: PlannerTick): void {
    const { ctx } = t;
    if (focus === null || t.harness.missionAborted || t.harness.activeMotion() !== null || ctx.tick < this.dwellRetryTick) return;
    const input: ProposalInput = {
      runId: t.harness.runId,
      aircraftId: ctx.profile.id,
      proposer: "local_planner",
      action: { kind: "scan", lookAt: focus, durationTicks },
      rationale: `Hold position and turn to face ${what}, so the forward cameras search it. Turning in place changes nothing else.`,
      citedEvidence: [],
      basis: { evidenceRevision: ctx.belief.evidenceRevision, mapRevision: ctx.belief.mapRevision, profileRevision: ctx.profile.revision, envelopeRevision: ctx.envelope.revision, policyRevision: ctx.policy.revision },
      createdTick: ctx.tick,
      expiresTick: ctx.tick + ROUTINE_LIFETIME_TICKS,
    };
    this.dwellScanId = this.start(input, { candidateId: null, focus, station: ctx.belief.pose.position, role: "dwell" }, t);
    if (this.dwellScanId === null) this.dwellRetryTick = ctx.tick + COOL_INVALID_TICKS;
  }

  /** Stop the scan facing the focus, if it is still the executing motion action. */
  private endDwell(reason: string, t: PlannerTick): void {
    const active = t.harness.activeMotion();
    if (active !== null && active.proposal.id === this.dwellScanId) this.stopMotion(active.proposal, reason, t);
    this.dwellScanId = null;
  }

  /**
   * Off station: run a station move. An attempt counts only when a station move ends without the aircraft on
   * station (or could not start), and the next one waits STATION_RETRY_TICKS, so attempts never burn per tick.
   * A dwell scan yields to a station move only here, where the aircraft is off station by the hysteresis
   * margin; once back on station manageFocus starts the scan again, so the two cannot preempt each other in a loop.
   */
  private ensureStationMove(record: ProposalRecord, station: Vec3, t: PlannerTick): void {
    const active = t.harness.activeMotion();
    if (active !== null && active.proposal.id === this.stationId) return;
    if (this.stationId !== null) this.stationMoveEnded(record, t);
    if (t.ctx.tick < this.stationRetryTick) return;
    const role = active === null ? null : this.meta.get(active.proposal.id)?.role;
    if (active !== null && role !== "candidate" && role !== "dwell") return;
    if (this.stationAttempts >= MAX_STATION_ATTEMPTS) {
      this.markUnreachable(station, t, `standoff not reached after ${MAX_STATION_ATTEMPTS} station moves`);
      t.harness.abort({ type: "abort", runId: t.harness.runId, scope: record.proposal.id, by: RUNTIME_ACTOR, tick: t.ctx.tick, reason: `the standoff could not be reached after ${MAX_STATION_ATTEMPTS} station moves` }, t.ctx);
      return;
    }
    if (active !== null) this.stopMotion(active.proposal, `superseded by the station move for ${record.proposal.id}`, t);
    const { ctx } = t;
    const meta = this.meta.get(record.proposal.id);
    const input: ProposalInput = {
      runId: t.harness.runId,
      aircraftId: ctx.profile.id,
      proposer: "local_planner",
      action: { kind: "move", goal: station, maxSpeedMps: Math.min(ctx.envelope.maxSpeedMps, ctx.profile.hardLimits.maxSpeedMps) },
      rationale: `Move to the standoff of ${record.proposal.action.kind} proposal ${record.proposal.id} so it can execute if the commander approves it. Moving changes nothing else.`,
      citedEvidence: [],
      basis: { evidenceRevision: ctx.belief.evidenceRevision, mapRevision: ctx.belief.mapRevision, profileRevision: ctx.profile.revision, envelopeRevision: ctx.envelope.revision, policyRevision: ctx.policy.revision },
      createdTick: ctx.tick,
      expiresTick: ctx.tick + ROUTINE_LIFETIME_TICKS,
    };
    this.stationId = this.start(input, { candidateId: null, focus: meta?.focus ?? null, station, role: "station" }, t);
    if (this.stationId === null) {
      this.stationAttempts += 1;
      this.stationRetryTick = ctx.tick + STATION_RETRY_TICKS;
    }
  }

  /** The station move is no longer executing: count it as an attempt unless it left the aircraft on station. */
  private stationMoveEnded(record: ProposalRecord, t: PlannerTick): void {
    if (!onStation(record.proposal, t.ctx)) this.stationAttempts += 1;
    this.stationId = null;
    this.stationRetryTick = t.ctx.tick + STATION_RETRY_TICKS;
  }

  private endFocus(record: ProposalRecord | null, t: PlannerTick): void {
    const meta = record === null ? undefined : this.meta.get(record.proposal.id);
    const ended = record === null ? null : record.status;
    // Invalidated at approval or stopped while executing for missing coverage alone: the same cure as a refusal at
    // submission (hold near the station facing the affected region, retry soon), not a long cooling elsewhere.
    const coverageOnly = endedForCoverage(record);
    if (ended !== null && ended !== "completed" && !coverageOnly) this.cool(meta?.candidateId ?? null, t.ctx.tick + (ended === "rejected" ? COOL_REJECTED_TICKS : COOL_INVALID_TICKS));
    const active = t.harness.activeMotion();
    if (active !== null && active.proposal.id === this.stationId && ended !== "completed") this.stopMotion(active.proposal, "its intervention ended before execution", t);
    this.endDwell("its intervention ended", t);
    this.focusId = null;
    this.stationId = null;
    this.lastPlanTick = nextPlanAfter(record, t.ctx.tick);
    if (coverageOnly && meta !== undefined) {
      this.cool(meta.candidateId, t.ctx.tick + COOL_COVERAGE_TICKS);
      this.afterCoverageRefusal(meta, t);
    }
  }

  private stopMotion(proposal: ActionProposal, reason: string, t: PlannerTick): void {
    t.harness.abort({ type: "abort", runId: t.harness.runId, scope: proposal.id, by: RUNTIME_ACTOR, tick: t.ctx.tick, reason }, t.ctx);
  }

  private cool(candidateId: string | null, until: Tick): void {
    if (candidateId !== null) this.cooling.set(candidateId, Math.max(until, this.cooling.get(candidateId) ?? 0));
  }

  /**
   * Go to the standoff and look first: the harness checks fresh person-search coverage of the affected region
   * at submission, so an intervention is proposed from its station after a short dwell.
   */
  private proposeFromStation(input: ProposalInput, meta: ProposalMeta, t: PlannerTick): void {
    const station = meta.station;
    if (station === null || distance(t.ctx.belief.pose.position, station) <= proposeNearM(input.action, t.ctx)) {
      if (this.waitToFace(input, meta, t)) return;
      this.propose(input, meta, t);
      return;
    }
    const active = t.harness.activeMotion();
    const activeMeta = active === null ? undefined : this.meta.get(active.proposal.id);
    // A move already flying to this station (a window look ends on its breach standoff) carries on: its arrival is the
    // preposition, and the plan on arrival proposes from there. No stop and restart on the way.
    if (activeMeta?.role === "candidate" && activeMeta.station !== null && distance(activeMeta.station, station) <= STILL_OFFERED_M) return;
    if (active !== null && activeMeta?.role === "candidate") this.stopMotion(active.proposal, `superseded by the move to the standoff of ${meta.candidateId ?? "an intervention"}`, t);
    if (t.harness.activeMotion() === null) this.preposition(station, meta, t);
  }

  /**
   * Coverage is judged at submission from what the cameras see, so an intervention waits (turning in place
   * toward its focus, at most MAX_FACE_WAITS times) until the aircraft faces it within FACE_TOLERANCE_RAD.
   */
  private waitToFace(input: ProposalInput, meta: ProposalMeta, t: PlannerTick): boolean {
    const focus = meta.focus ?? actionFocus(input.action);
    const key = meta.candidateId ?? "";
    const off = facingErrorRad(t.ctx.belief.pose, focus);
    const waited = this.faceWaits.get(key) ?? 0;
    if (off === null || off <= FACE_TOLERANCE_RAD || waited >= MAX_FACE_WAITS) {
      this.faceWaits.delete(key);
      return false;
    }
    this.faceWaits.set(key, waited + 1);
    this.faceFocus(focus, FACE_WAIT_TICKS * 2, `the affected region of candidate ${meta.candidateId ?? "?"} before proposing it (${Math.round((off * 180) / Math.PI)}° off)`, t);
    this.dwellUntil = Math.max(this.dwellUntil, t.ctx.tick + FACE_WAIT_TICKS);
    return true;
  }

  /** A routine move to an intervention's station (no proposal yet); planning resumes after a dwell there. */
  private preposition(station: Vec3, meta: ProposalMeta, t: PlannerTick): void {
    const { ctx } = t;
    const input: ProposalInput = {
      runId: t.harness.runId,
      aircraftId: ctx.profile.id,
      proposer: "local_planner",
      action: { kind: "move", goal: station, maxSpeedMps: Math.min(ctx.envelope.maxSpeedMps, ctx.profile.hardLimits.maxSpeedMps) },
      rationale: `Move to the standoff of candidate ${meta.candidateId ?? "?"} and look at its affected region before proposing it; nothing is proposed or actuated yet.`,
      citedEvidence: [],
      basis: { evidenceRevision: ctx.belief.evidenceRevision, mapRevision: ctx.belief.mapRevision, profileRevision: ctx.profile.revision, envelopeRevision: ctx.envelope.revision, policyRevision: ctx.policy.revision },
      createdTick: ctx.tick,
      expiresTick: ctx.tick + ROUTINE_LIFETIME_TICKS,
    };
    if (this.start(input, { ...meta, station, role: "preposition" }, t) !== null) this.dwellUntil = -Infinity;
  }

  /** Called when a preposition move ends (by the runtime each tick): dwell before the next plan. */
  noteArrival(t: PlannerTick): void {
    const active = t.harness.activeMotion();
    if (active !== null) return;
    const last = [...this.meta.entries()].reverse().find(([, m]) => m.role === "preposition");
    if (last === undefined) return;
    const record = t.harness.record(last[0]);
    if (record?.status === "completed" && !this.dwelled.has(last[0])) {
      this.dwelled.add(last[0]);
      this.dwellUntil = t.ctx.tick + DWELL_TICKS;
      this.lastPlanTick = -Infinity;
      this.faceFocus(last[1].focus, DWELL_TICKS, `the affected region of candidate ${last[1].candidateId ?? "?"} before proposing it`, t);
    }
  }

  /**
   * Too little fresh coverage is usually cured by looking longer: dwell facing the affected region and retry soon.
   * When looking longer from the same station has already failed, leave it out for a while so another is tried.
   */
  private afterCoverageRefusal(meta: ProposalMeta, t: PlannerTick): void {
    if (meta.station !== null && this.coverageRefused(meta.station)) {
      this.avoid(meta.station, t, `refused ${AVOID_AFTER_COVERAGE_REFUSALS} times running for coverage from here`);
      return;
    }
    this.dwellUntil = t.ctx.tick + DWELL_TICKS;
    if (meta.candidateId !== null) this.coverageRetry.set(meta.candidateId, t.ctx.tick + COOL_COVERAGE_TICKS);
    this.faceFocus(meta.focus, DWELL_TICKS, `the affected region of candidate ${meta.candidateId ?? "?"} until fresh coverage allows proposing it`, t);
  }

  /** Count a coverage-only refusal from `station`; true when it reaches AVOID_AFTER_COVERAGE_REFUSALS (the count then restarts). */
  private coverageRefused(station: Vec3): boolean {
    const known = this.coverageRefusals.find(r => distance(r.point, station) <= SAME_STATION_M);
    const count = (known?.count ?? 0) + 1;
    this.coverageRefusals = [...this.coverageRefusals.filter(r => r !== known), ...(count >= AVOID_AFTER_COVERAGE_REFUSALS ? [] : [{ point: station, count }])];
    return count >= AVOID_AFTER_COVERAGE_REFUSALS;
  }

  private avoid(point: Vec3, t: PlannerTick, why: string): void {
    const mark = this.unreachable.mark(point, t.ctx.tick);
    const lasting = mark.until === Infinity ? "for the rest of the run" : `for ${((mark.until - t.ctx.tick) / 100).toFixed(0)} s`;
    t.log.append({ tick: t.ctx.tick, source: "planner", kind: "planner.station_avoided", subject: null, reason: `Station (${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)}) left out ${lasting} (${why}); candidates stationed within ${UNREACHABLE_RADIUS_M} m of it are not offered meanwhile.`, data: { point: { x: point.x, y: point.y, z: point.z }, marks: mark.stalls, untilTick: Number.isFinite(mark.until) ? mark.until : null } });
  }

  private markUnreachable(point: Vec3, t: PlannerTick, why: string): void {
    const mark = this.unreachable.mark(point, t.ctx.tick);
    const lasting = mark.until === Infinity ? "for the rest of the run" : `for ${((mark.until - t.ctx.tick) / 100).toFixed(0)} s`;
    t.log.append({ tick: t.ctx.tick, source: "planner", kind: "planner.goal_unreachable", subject: null, reason: `Goal (${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)}) marked unreachable ${lasting} (${why}; stall ${mark.stalls} at this point); candidates stationed within ${UNREACHABLE_RADIUS_M} m of it are not offered meanwhile.`, data: { point: { x: point.x, y: point.y, z: point.z }, stalls: mark.stalls, untilTick: Number.isFinite(mark.until) ? mark.until : null } });
  }

  private targetOf(candidateId: string): CandidateTarget | null {
    if (this.lastSet === null) return null;
    const candidate = resolveCandidate(this.lastSet, candidateId);
    return candidate?.target ?? null;
  }
}

/**
 * A running guide yields to the newest set's choice once that set offers the homeward return or the look that
 * refreshes its route: the factory offers those only when every guided person has left or arrived.
 */
export function guideYields(set: CandidateSet): boolean {
  return set.candidates.some(c => isHomeward(c) || isReturnRefresh(c));
}

/** Tracks guidance has run for: every guide that began executing, with its route and the tick it started. */
export function guidedTracks(records: readonly ProposalRecord[]): GuidedTrack[] {
  return records.flatMap(record => {
    const action = record.proposal.action;
    const started = action.kind === "guide" ? record.history.find(entry => entry.status === "executing") : undefined;
    return action.kind === "guide" && started !== undefined ? [{ trackId: action.trackId, routeId: action.routeId, sinceTick: started.tick }] : [];
  });
}

/**
 * The lastPlanTick to set when an intervention ends: after a completed strike, plan again once the cameras have reported
 * the broken pane (PLAN_PERIOD_TICKS later), not on the very tick it completes, when the evidence still shows it closed
 * and the plan would start a move it drops half a second later; otherwise plan at once.
 */
function nextPlanAfter(record: ProposalRecord | null, tick: Tick): Tick {
  return record?.status === "completed" && record.proposal.action.kind === "breach_opening" ? tick : -Infinity;
}

/** An intervention that ended, other than completed or rejected by the commander, for missing coverage alone. */
function endedForCoverage(record: ProposalRecord | null): boolean {
  return record !== null && record.status !== "completed" && record.status !== "rejected" && coverageOnlyFindings(record.findings);
}

/** Every finding is H6 missing coverage: looking longer from the station can cure it. */
function coverageOnlyFindings(findings: readonly { readonly ruleId: string; readonly reason: string }[]): boolean {
  return findings.length > 0 && findings.every(f => f.ruleId === "H6" && /coverage/i.test(f.reason));
}

/**
 * Goals that stopped making progress. A mark covers UNREACHABLE_RADIUS_M around the goal for UNREACHABLE_TICKS;
 * a repeated stall within that radius of a marked point (after its mark expired, or from another goal nearby)
 * doubles the duration, and the UNREACHABLE_PERMANENT_AFTER-th makes it last for the run.
 */
export class UnreachableMarks {
  private readonly marks: { point: Vec3; until: Tick; stalls: number }[] = [];

  /** Record a stall at `point`; returns the resulting mark. */
  mark(point: Vec3, tick: Tick): { readonly until: Tick; readonly stalls: number } {
    const known = this.marks.find(m => distance(m.point, point) <= UNREACHABLE_RADIUS_M);
    const stalls = (known?.stalls ?? 0) + 1;
    const until = stalls >= UNREACHABLE_PERMANENT_AFTER ? Infinity : tick + UNREACHABLE_TICKS * 2 ** (stalls - 1);
    if (known === undefined) this.marks.push({ point, until, stalls });
    else {
      known.until = Math.max(known.until, until);
      known.stalls = stalls;
    }
    return { until: known?.until ?? until, stalls };
  }

  /** Whether a station at `point` is left out at `tick`. */
  has(point: Vec3, tick: Tick): boolean {
    return this.marks.some(m => m.until > tick && distance(m.point, point) <= UNREACHABLE_RADIUS_M);
  }

  /** The marks in force at `tick`, for the candidate factory to choose stations away from. */
  active(tick: Tick): { readonly point: Vec3; readonly radiusM: number }[] {
    return this.marks.filter(m => m.until > tick).map(m => ({ point: m.point, radiusM: UNREACHABLE_RADIUS_M }));
  }
}

/**
 * Whether the aircraft can execute the intervention from its estimated position. A strike leaves along the
 * estimated offset to the strike point and only takes effect within the breaker's reach of the true aircraft
 * (simulation/actuators.ts), so a breach additionally needs the estimated strike distance at least
 * STRIKE_MARGIN_M inside that reach; the harness separately checks the standoff tolerance (H11).
 */
export function onStation(proposal: ActionProposal, ctx: HarnessContext): boolean {
  const station = stationOf(proposal);
  const pose = ctx.belief.pose.position;
  if (station === null) return true;
  const action = proposal.action;
  if (action.kind === "breach_opening") {
    const reachM = ctx.profile.modules.glassBreaker?.reachM ?? 0;
    return distance(pose, action.strikePoint) <= reachM - STRIKE_MARGIN_M && distance(pose, action.standoff) <= ctx.policy.standoffToleranceM;
  }
  return distance(pose, station) <= onStationM(ctx);
}

/** On-station distance for interventions other than a breach: inside the harness's standoff tolerance (H11) by ON_STATION_MARGIN_M. */
export function onStationM(ctx: HarnessContext): number {
  return ctx.policy.standoffToleranceM - ON_STATION_MARGIN_M;
}

/** How close to its station an intervention must be to be proposed directly instead of prepositioning. */
export function proposeNearM(action: ProposalInput["action"], ctx: HarnessContext): number {
  return action.kind === "breach_opening" ? PREPOSITION_NEAR_M : onStationM(ctx) - PROPOSE_MARGIN_M;
}

/**
 * Goal of the routine station move for an intervention. For a breach it lies BREACH_DOCK_M from the strike
 * point on the standoff side: the controller's docking braking stops the aircraft about 0.3 m from the pane
 * long before the goal, and the harness's 0.3 m arrival tolerance can only end the move within reach of the
 * strike point; execution starts as soon as onStation holds.
 */
export function stationGoal(proposal: ActionProposal, reachM = 0): Vec3 | null {
  const action = proposal.action;
  if (action.kind !== "breach_opening") return stationOf(proposal);
  const d = distance(action.standoff, action.strikePoint);
  // A striker that reaches the pane from the standoff (with the strike margin) needs no docking: hold the standoff.
  if (d <= BREACH_DOCK_M || d <= reachM - STRIKE_MARGIN_M) return action.standoff;
  const k = BREACH_DOCK_M / d;
  const s = action.strikePoint;
  return { x: s.x + (action.standoff.x - s.x) * k, y: s.y + (action.standoff.y - s.y) * k, z: s.z + (action.standoff.z - s.z) * k };
}

/** What an intervention acts on, for the forward cameras to face: the planner's focus, else the aim or strike point. */
export function interventionFocus(proposal: ActionProposal, meta: ProposalMeta | undefined): Vec3 | null {
  if (meta?.focus) return meta.focus;
  const action = proposal.action;
  if (action.kind === "spray") return action.aimPoint;
  if (action.kind === "breach_opening") return action.strikePoint;
  return null;
}

/** Where an intervention must be executed from; null when it acts in place. */
export function stationOf(proposal: ActionProposal): Vec3 | null {
  const action = proposal.action;
  if (action.kind === "spray" || action.kind === "breach_opening") return action.standoff;
  if (action.kind === "release_payload") return action.releasePoint;
  return null;
}

/** Evidence that should prompt a replan mid-move: tracks, fire sightings, opening states, route statuses, reports. */
export function relevantSignature(belief: BeliefSnapshot): string {
  const tracks = belief.tracks.map(track => `${track.id}:${track.status}`).join(",");
  // The latest fire sighting per place, flame or out: a fire going out changes the signature and replans.
  const place = (h: BeliefSnapshot["hazards"][number]) => `${Math.round(h.region.kind === "sphere" ? h.region.center.x : 0)},${Math.round(h.region.kind === "sphere" ? h.region.center.y : 0)}`;
  const recentFires = belief.hazards.filter(h => h.hazard === "fire" && belief.tick - h.tick <= 500);
  const fireRooms = new Set(latestBy(recentFires, place, h => h.tick).map(h => `${place(h)}:${h.intensity > 0 ? "flame" : "out"}`));
  const openings = latestBy(belief.openings, o => o.openingId, o => o.tick).map(o => `${o.openingId}:${o.state}`).join(",");
  const routes = latestBy(belief.routes, r => r.id, r => r.assessedTick).map(r => `${r.id}:${r.status}`).join(",");
  return `${tracks}|${[...fireRooms].sort().join(",")}|${openings}|${routes}|${belief.reports.length}`;
}

function latestBy<T>(items: readonly T[], key: (item: T) => string, tick: (item: T) => number): T[] {
  const latest = new Map<string, T>();
  for (const item of items) {
    const known = latest.get(key(item));
    if (known === undefined || tick(item) >= tick(known)) latest.set(key(item), item);
  }
  return [...latest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, item]) => item);
}

/**
 * Whether the floor-plan prior and current opening evidence offer a flight path from the estimated pose to
 * `station` (steering-graph.ts). A station inside a room with no observed way in (e.g. a second viewpoint
 * behind intact glass) has none, and is not offered: the follower would otherwise fly straight at the wall.
 */
export function flightPathExists(ctx: HarnessContext, station: Vec3): boolean {
  const belief = ctx.belief;
  const from = belief.pose.position;
  if (spaceOf(belief.mapPrior, from) === spaceOf(belief.mapPrior, station) && distance(from, station) < 0.5) return true;
  return findFlightPath({ prior: belief.mapPrior, openings: belief.openings, hazards: belief.hazards, tick: belief.tick, from, goal: station, clearanceM: ctx.profile.spanM / 2 + 0.05 }) !== null;
}
