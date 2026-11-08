/**
 * Local deterministic planner: ranks the application-generated candidates without any cloud service.
 *
 *   score = tool priority + report relevance + expected new observation + evidence age
 *           + tool adjustment − travel cost from the estimated pose
 *
 * For a breach the adjustment scores the window's access (candidates.ts BreachAccess): a drone-passable way
 * from its room toward the fire, a possible occupant or a reported room, fewer openings first; penalties for a
 * room that only closed doors lead out of, a room holding a possible occupant, or a window with no exterior
 * approach; small bonuses for how much of the debris region is in view from the standoff and how well the
 * aircraft fits the pane. A post-suppression route-sweep step ranks above second looks; after guidance, standing
 * clear of the guided person's way out ranks above observation, and once every guided occupant has left or
 * arrived the return to base ranks first, or, while the return route still lacks fresh evidence, the look that
 * refreshes it.
 *
 * It reads only the candidate set and the truth-free belief, so it cannot see hidden people or award itself
 * extra knowledge. Equal scores break by canonical tool order, then candidate id, so the ranking never
 * depends on input order. Like OpenAI Decisions, it only picks a candidate id: the harness validates the
 * resulting proposal and the commander still approves every intervention.
 */
import type { Tick } from "../../contracts/clock.ts";
import type { BeliefSnapshot, RoomCoverage } from "../../contracts/evidence.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { distance } from "../../contracts/frames.ts";
import type { RoomId } from "../../contracts/ids.ts";
import { deepFreeze } from "../../contracts/ids.ts";
import type { HarnessPolicy } from "../../harness/policy.ts";
import { DEFAULT_POLICY } from "../../harness/policy.ts";
import { BREACH_ACCESS_WEIGHTS, breachAccessScore, MAX_ACCESS_BONUS, unconfirmedAccessScore } from "./access-score.ts";
import { breachAccessOf, isHomeward, isReturnRefresh, isRouteSweep, isStandClear, isWindowLook, latestOpeningEvidence, latestRoutes, observedOpenEntries, reportedRooms } from "./candidates.ts";
import { compareText } from "./text.ts";
import type { CandidateSet, CandidateTool, MissionCandidate, MissionTool, ProposalCandidate } from "./types.ts";
import { TOOL_ORDER } from "./types.ts";

export interface ScoreBreakdown {
  readonly base: number;
  readonly report: number;
  readonly newObservation: number;
  readonly evidenceAge: number;
  readonly adjustment: number;
  readonly travel: number;
  readonly total: number;
}

export interface RankedCandidate {
  readonly id: string;
  readonly tool: CandidateTool;
  /** Null for `defer` and `request_human_review`, which are listed after every proposal and never ranked. */
  readonly score: ScoreBreakdown | null;
}

export interface LocalPlan {
  /** The highest-ranked proposal candidate, or "defer" when there is none. */
  readonly choiceId: string;
  readonly ranked: readonly RankedCandidate[];
}

/**
 * Weights. Tool priorities follow the rescue: guidance along a supported route, then suppression, a second
 * look at a lead, access, observation and return. A report raises relevance within a tool; it never
 * creates a person.
 */
export const PLANNER_WEIGHTS = deepFreeze({
  base: { guide_to_exit: 60, request_suppression: 50, investigate_signal: 40, request_breach: 30, inspect_room: 20, return_to_base: 10 } satisfies { readonly [tool in MissionTool]: number },
  report: 8,
  newObservation: 6,
  evidenceAge: 2,
  travelPerM: 0.2,
  maxTravelM: 40,
  /**
   * Breaking glass ranks below entering when an observed open exterior opening exists. The largest access
   * bonus is taken off as well, so the best-placed window never scores above what this penalty allowed.
   */
  observedEntryPenalty: 25,
  /** Breach access (types.ts BreachAccess; scored in access-score.ts). */
  breach: BREACH_ACCESS_WEIGHTS,
  /** A look at an unobserved window whose discounted access beats every observed breach ranks this far above the best breach. */
  sizeUpLead: 1,
  /** A step of the post-suppression route sweep (candidates.ts isRouteSweep): above a second look, below guidance. */
  routeSweep: 35,
  /** Standing clear of a guided person's way out (candidates.ts isStandClear): above second looks and observation. */
  standClear: 15,
  /** Returning once every guided occupant has left or arrived (candidates.ts isHomeward): first. */
  homeward: 80,
  /** A look that refreshes the return route's evidence once the return is homeward (candidates.ts isReturnRefresh): first while no return is on offer. */
  returnRefresh: 70,
  /** Suppression near a possible occupant or on an unsupported evacuation route. */
  rescueRelevance: 5,
  rescueRadiusM: 5,
  routeBlockM: 1.5,
  /** A room's observation value recovers over 10 s after it was last observed. */
  reobserveTicks: 1000,
  /** A lead not seen for 15 s is fully stale. */
  trackRecheckTicks: 1500,
});

const W = PLANNER_WEIGHTS;

interface PlannerCtx {
  readonly now: Tick;
  readonly pose: Vec3;
  readonly policy: HarnessPolicy;
  readonly belief: BeliefSnapshot;
  readonly coverage: ReadonlyMap<RoomId, RoomCoverage>;
  readonly reported: ReadonlySet<RoomId>;
  readonly observedEntry: boolean;
}

type ToolTerms = Omit<ScoreBreakdown, "base" | "travel" | "total">;

/** Rank the set's candidates for the belief they were built from. The result is deeply frozen. */
export function rankCandidates(set: CandidateSet, belief: BeliefSnapshot, policy: HarnessPolicy = DEFAULT_POLICY): LocalPlan {
  if (set.runId !== belief.runId) throw new RangeError(`Candidate set for run ${set.runId} cannot be ranked with a belief for run ${belief.runId}`);
  const ctx = plannerContext(belief, policy);
  const proposals = sizeUpLift(set, set.candidates.filter(isProposalCandidate).map(candidate => ({ id: candidate.id, tool: candidate.tool, score: scoreCandidate(ctx, candidate) })));
  proposals.sort((a, b) => b.score.total - a.score.total || compareTools(a.tool, b.tool) || compareText(a.id, b.id));
  const choices: RankedCandidate[] = set.candidates
    .filter(candidate => candidate.proposal === null)
    .map(candidate => ({ id: candidate.id, tool: candidate.tool, score: null }))
    .sort((a, b) => compareTools(a.tool, b.tool) || compareText(a.id, b.id));
  return deepFreeze({ choiceId: proposals.length > 0 ? proposals[0].id : "defer", ranked: [...proposals, ...choices] });
}

type ScoredProposal = { readonly id: string; readonly tool: MissionTool; readonly score: ScoreBreakdown };

/**
 * The 360° size-up rule: a look at an unobserved window whose discounted access beats every observed breach
 * (candidates.ts sizeUpLooks) ranks above the best breach. The qualifying looks are lifted together by the
 * same amount, so their own order (access, observation value, travel) is kept and the lowest of them ends
 * PLANNER_WEIGHTS.sizeUpLead above the best breach. The lift is part of the adjustment, so totals still add up.
 */
function sizeUpLift(set: CandidateSet, scored: readonly ScoredProposal[]): ScoredProposal[] {
  const byId = new Map(set.candidates.map(candidate => [candidate.id, candidate]));
  const breaches = scored.filter(entry => entry.tool === "request_breach");
  const breachAccess = breaches.flatMap(entry => {
    const candidate = byId.get(entry.id);
    const access = candidate === undefined ? null : breachAccessOf(candidate);
    return access === null ? [] : [breachAccessScore(access)];
  });
  if (breaches.length === 0) return looksBeforeInspections(byId, scored);
  if (breachAccess.length === 0) return [...scored];
  const bestAccess = Math.max(...breachAccess);
  const looks = new Set(scored.filter(entry => {
    const candidate = byId.get(entry.id);
    return candidate !== undefined && isWindowLook(candidate) && candidate.target !== null && candidate.target.access !== null && unconfirmedAccessScore(candidate.target.access) > bestAccess;
  }).map(entry => entry.id));
  if (looks.size === 0) return [...scored];
  const bestBreach = Math.max(...breaches.map(entry => entry.score.total));
  const lowestLook = Math.min(...scored.filter(entry => looks.has(entry.id)).map(entry => entry.score.total));
  const lift = Math.max(0, bestBreach + W.sizeUpLead - lowestLook);
  if (lift === 0) return [...scored];
  return scored.map(entry => (looks.has(entry.id) ? { ...entry, score: { ...entry.score, adjustment: round6(entry.score.adjustment + lift), total: round6(entry.score.total + lift) } } : entry));
}

/**
 * Demo: with no breach on offer yet, a look at a window worth breaking (positive unconfirmed access; it ends on the
 * window's breach standoff) ranks PLANNER_WEIGHTS.sizeUpLead above every room inspection, so the first move goes
 * straight to the entry window instead of inspecting rooms from outside first.
 */
function looksBeforeInspections(byId: ReadonlyMap<string, MissionCandidate>, scored: readonly ScoredProposal[]): ScoredProposal[] {
  const looks = new Set(scored.filter(entry => {
    const candidate = byId.get(entry.id);
    return candidate !== undefined && isWindowLook(candidate) && candidate.target !== null && candidate.target.access !== null && unconfirmedAccessScore(candidate.target.access) > 0;
  }).map(entry => entry.id));
  const inspections = scored.filter(entry => entry.tool === "inspect_room" && !looks.has(entry.id));
  if (looks.size === 0 || inspections.length === 0) return [...scored];
  const bestInspection = Math.max(...inspections.map(entry => entry.score.total));
  const lowestLook = Math.min(...scored.filter(entry => looks.has(entry.id)).map(entry => entry.score.total));
  const lift = Math.max(0, bestInspection + W.sizeUpLead - lowestLook);
  if (lift === 0) return [...scored];
  return scored.map(entry => (looks.has(entry.id) ? { ...entry, score: { ...entry.score, adjustment: round6(entry.score.adjustment + lift), total: round6(entry.score.total + lift) } } : entry));
}

export function isProposalCandidate(candidate: MissionCandidate): candidate is ProposalCandidate {
  return candidate.proposal !== null;
}

function compareTools(a: CandidateTool, b: CandidateTool): number {
  return TOOL_ORDER.indexOf(a) - TOOL_ORDER.indexOf(b);
}

function plannerContext(belief: BeliefSnapshot, policy: HarnessPolicy): PlannerCtx {
  const freshFrom = belief.tick - policy.citedEvidenceMaxAgeTicks;
  return {
    now: belief.tick,
    pose: belief.pose.position,
    policy,
    belief,
    coverage: new Map(belief.coverage.map(entry => [entry.roomId, entry])),
    reported: reportedRooms(belief),
    observedEntry: observedOpenEntries(belief, latestOpeningEvidence(belief.openings), freshFrom).length > 0,
  };
}

function scoreCandidate(ctx: PlannerCtx, candidate: ProposalCandidate): ScoreBreakdown {
  const terms = toolTerms(ctx, candidate);
  const station = candidate.target.station;
  const travel = station === null ? 0 : W.travelPerM * Math.min(distance(ctx.pose, station), W.maxTravelM);
  const base = W.base[candidate.tool];
  const total = base + terms.report + terms.newObservation + terms.evidenceAge + terms.adjustment - travel;
  return {
    base,
    report: round6(terms.report),
    newObservation: round6(terms.newObservation),
    evidenceAge: round6(terms.evidenceAge),
    adjustment: round6(terms.adjustment),
    travel: round6(travel),
    total: round6(total),
  };
}

function toolTerms(ctx: PlannerCtx, candidate: ProposalCandidate): ToolTerms {
  switch (candidate.tool) {
    case "inspect_room":
      return inspectTerms(ctx, candidate);
    case "investigate_signal":
      return investigateTerms(ctx, candidate);
    case "request_breach":
      return breachTerms(ctx, candidate);
    case "request_suppression":
      return suppressionTerms(ctx, candidate);
    case "guide_to_exit":
      return { report: reportTerm(ctx, candidate), newObservation: 0, evidenceAge: W.evidenceAge * freshness(ctx, candidate.target.evidenceTick, ctx.policy.routeFreshTicks), adjustment: 0 };
    case "return_to_base":
      return returnTerms(ctx, candidate);
  }
}

/**
 * Observation value: an unobserved room is worth most, a degraded room by how much of it lacks adequate
 * coverage. A report and evidence age both scale with staleness, so a room observed a moment ago is not
 * re-inspected in a loop just because a report names it.
 */
function inspectTerms(ctx: PlannerCtx, candidate: ProposalCandidate): ToolTerms {
  const staleness = stalenessOf(ctx, candidate.target.evidenceTick, W.reobserveTicks);
  const access = isWindowLook(candidate) ? candidate.target.access : null;
  return {
    report: reportTerm(ctx, candidate) * staleness,
    newObservation: W.newObservation * roomObservationValue(ctx, candidate.target.roomId),
    evidenceAge: W.evidenceAge * staleness,
    // A size-up look at a window carries the window's unconfirmed access (sizeUpLift ranks it above the breach);
    // a route-sweep step ranks above second looks so the route's evidence is gathered in one pass.
    adjustment: (access === null ? 0 : unconfirmedAccessScore(access)) + (isRouteSweep(candidate) ? W.routeSweep : 0) + (isReturnRefresh(candidate) ? W.returnRefresh : 0),
  };
}

/** A second view helps most for a low-confidence lead and for one not seen recently. */
function investigateTerms(ctx: PlannerCtx, candidate: ProposalCandidate): ToolTerms {
  const track = ctx.belief.tracks.find(t => t.id === candidate.target.trackId);
  const confidence = Math.min(1, Math.max(0, track?.confidence ?? 0));
  return {
    report: reportTerm(ctx, candidate),
    newObservation: W.newObservation * (1 - confidence),
    evidenceAge: W.evidenceAge * stalenessOf(ctx, candidate.target.evidenceTick, W.trackRecheckTicks),
    adjustment: isStandClear(candidate) ? W.standClear : 0,
  };
}

function breachTerms(ctx: PlannerCtx, candidate: ProposalCandidate): ToolTerms {
  const access = breachAccessOf(candidate);
  const accessTerm = access === null ? 0 : breachAccessScore(access);
  return {
    report: reportTerm(ctx, candidate),
    newObservation: W.newObservation * roomObservationValue(ctx, candidate.target.roomId),
    evidenceAge: W.evidenceAge * freshness(ctx, candidate.target.evidenceTick, ctx.policy.citedEvidenceMaxAgeTicks),
    adjustment: accessTerm - (ctx.observedEntry ? W.observedEntryPenalty + MAX_ACCESS_BONUS : 0),
  };
}

function suppressionTerms(ctx: PlannerCtx, candidate: ProposalCandidate): ToolTerms {
  return {
    report: reportTerm(ctx, candidate),
    newObservation: 0,
    evidenceAge: W.evidenceAge * freshness(ctx, candidate.target.evidenceTick, ctx.policy.citedEvidenceMaxAgeTicks),
    adjustment: rescueRelevant(ctx, candidate.target.focus) ? W.rescueRelevance : 0,
  };
}

/** Prefer the shorter and more recently assessed return route; first of all once every guided occupant is out. */
function returnTerms(ctx: PlannerCtx, candidate: ProposalCandidate): ToolTerms {
  const route = latestRoutes(ctx.belief.routes).find(r => r.id === candidate.target.routeId);
  const durationS = route !== undefined && Number.isFinite(route.estimatedDurationS) ? route.estimatedDurationS : 120;
  return {
    report: 0,
    newObservation: 0,
    evidenceAge: W.evidenceAge * freshness(ctx, candidate.target.evidenceTick, ctx.policy.returnRouteFreshTicks),
    adjustment: -Math.min(Math.max(durationS, 0), 120) / 60 + (isHomeward(candidate) ? W.homeward : 0),
  };
}

function reportTerm(ctx: PlannerCtx, candidate: ProposalCandidate): number {
  const roomId = candidate.target.roomId;
  return roomId !== null && ctx.reported.has(roomId) ? W.report : 0;
}

function roomObservationValue(ctx: PlannerCtx, roomId: RoomId | null): number {
  if (roomId === null) return 0;
  const entry = ctx.coverage.get(roomId);
  if (entry === undefined || entry.state === "unobserved") return 1;
  // Value comes from what is still unsearched for people, not the run-wide "observed" state, which never decays.
  if (entry.fractionSearched !== undefined) return Math.min(1, Math.max(0, 1 - entry.fractionSearched));
  if (entry.state === "observed") return 0;
  return Math.min(0.8, Math.max(0.2, 1 - entry.fractionAdequate));
}

/** A fire near a possible occupant, or on an evacuation route that is not supported, blocks a rescue. */
function rescueRelevant(ctx: PlannerCtx, focus: Vec3 | null): boolean {
  if (focus === null) return false;
  const nearTrack = ctx.belief.tracks.some(track => track.status === "possible" && distance(track.position, focus) <= W.rescueRadiusM);
  return nearTrack || latestRoutes(ctx.belief.routes).some(route => route.purpose === "evacuation" && route.status !== "supported" && polylineDistance(route.waypoints, focus) <= W.routeBlockM);
}

function polylineDistance(points: readonly Vec3[], p: Vec3): number {
  if (points.length === 1) return distance(points[0], p);
  let best = Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, segmentDistance(points[i - 1], points[i], p));
  return best;
}

function segmentDistance(a: Vec3, b: Vec3, p: Vec3): number {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const lengthSquared = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / lengthSquared));
  return distance({ x: a.x + t * ab.x, y: a.y + t * ab.y, z: a.z + t * ab.z }, p);
}

/** 1 for evidence from now, falling to 0 at `windowTicks` old; 0 without evidence. */
function freshness(ctx: PlannerCtx, tick: Tick | null, windowTicks: number): number {
  if (tick === null || !(windowTicks > 0)) return 0;
  return clamp01(1 - (ctx.now - tick) / windowTicks);
}

/** 0 for evidence from now, rising to 1 at `periodTicks` old; 1 when never observed. */
function stalenessOf(ctx: PlannerCtx, tick: Tick | null, periodTicks: number): number {
  if (tick === null) return 1;
  return clamp01((ctx.now - tick) / periodTicks);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round6(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}
