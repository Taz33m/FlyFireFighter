/**
 * Harness rules. Each rule is a small function returning findings; validation collects every finding for
 * the phase instead of stopping at the first. Rules read only the proposal, the harness context (aircraft
 * profile, policy, mission envelope and the truth-free belief snapshot) and the harness's own state. They
 * never read simulator truth, and a proposer cannot lower a risk class or skip a check.
 *
 * Phases: submit and approve run every rule except H5 and H11; execute runs every rule; monitor (every
 * executing tick) runs H0, H1, H2 (flow, reaction, ambient, reserve), H4 (revisions, supersession, map
 * changes — not cited age), H6, H8, H10, H11, H15 and H19.
 *
 * Every comparison of an estimate against a limit is written so that a NaN (or otherwise non-comparable)
 * estimate fails the check: `!(estimate <= limit)` rather than `estimate > limit`.
 */
import type { ActionKind, ActionProposal, ActionSpec, Approval, Finding, ProposalStatus } from "../contracts/actions.ts";
import { SPEECH_TEMPLATES } from "../contracts/actions.ts";
import type { Tick } from "../contracts/clock.ts";
import { secondsFromTicks } from "../contracts/clock.ts";
import { envelopeContains, hardLimitViolations } from "../contracts/envelope.ts";
import type { FireClassAssessment, HazardEvidence, OpeningEvidence, RouteAssessment } from "../contracts/evidence.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distance } from "../contracts/frames.ts";
import type { Region } from "../contracts/geometry.ts";
import { distanceToRegion, regionBounds, regionsOverlap, representativePoint, sphere } from "../contracts/geometry.ts";
import type { ObservationId, OpeningId, ProposalId, RouteId, RunId, TrackId } from "../contracts/ids.ts";
import { assessFireClass } from "../evidence/fire-class.ts";
import { coverageOf } from "./coverage.ts";
import type { BreachSpec, SpraySpec } from "./effects.ts";
import { affectedRegion, dependencyRegion, jetReactionN, MIN_AIM_DISTANCE_M, sprayDoseL, sprayRegion } from "./effects.ts";
import { localizationSupportsAdvance } from "./motion-guard.ts";
import {
  clearedByLaterLook, closesInOn, describeOccupant, guideLeadIndex, isCurrentOccupant, isGuidedPerson, personClearanceFor, possibleOccupants, requiredPersonDistanceM,
} from "./person-clearance.ts";
import type { HarnessContext } from "./policy.ts";
import { CONTINGENCY_KINDS, INTERVENTION_KINDS, MOTION_KINDS, riskClassOf } from "./policy.ts";
import type { SprayDischarge } from "./respray.ts";
import { sprayAfterSighting } from "./respray.ts";

export type ValidationPhase = "submit" | "approve" | "execute" | "monitor";

/** Harness state the rules may read. */
export interface RuleState {
  readonly runId: RunId;
  readonly missionAborted: boolean;
  /** Tick of the latest completed or stopped spray/breach that had effects; a spray in progress counts as now. */
  readonly lastInterventionTick: Tick | null;
  /** Every spray that discharged water or is discharging (respray.ts), for H14's look-before-spraying-again check. */
  readonly sprays: readonly SprayDischarge[];
}

export interface RuleInput {
  readonly phase: ValidationPhase;
  readonly proposal: ActionProposal;
  readonly ctx: HarnessContext;
  readonly state: RuleState;
  readonly status: ProposalStatus;
  readonly approval: Approval | null;
}

export interface RuleDefinition {
  readonly id: string;
  readonly title: string;
  readonly phases: readonly ValidationPhase[];
  readonly check: (input: RuleInput) => Finding[];
}

const PRE_EXECUTION: readonly ValidationPhase[] = ["submit", "approve", "execute"];
const EVERY_PHASE: readonly ValidationPhase[] = ["submit", "approve", "execute", "monitor"];

export const RULES: readonly RuleDefinition[] = [
  { id: "H0", title: "Aircraft identity", phases: EVERY_PHASE, check: identityRule },
  { id: "H1", title: "Capability", phases: EVERY_PHASE, check: capabilityRule },
  { id: "H2", title: "Limits", phases: EVERY_PHASE, check: limitsRule },
  { id: "H3", title: "Mission envelope", phases: PRE_EXECUTION, check: envelopeRule },
  { id: "H4", title: "Basis and evidence", phases: EVERY_PHASE, check: basisRule },
  { id: "H5", title: "Approval binding", phases: ["execute"], check: approvalRule },
  { id: "H6", title: "Affected-region safety", phases: EVERY_PHASE, check: regionSafetyRule },
  { id: "H8", title: "Truthful speech", phases: EVERY_PHASE, check: speechRule },
  { id: "H10", title: "Localization", phases: EVERY_PHASE, check: localizationRule },
  { id: "H11", title: "Monitored standoff", phases: ["execute", "monitor"], check: standoffRule },
  { id: "H14", title: "Purpose", phases: PRE_EXECUTION, check: purposeRule },
  { id: "H15", title: "Routes", phases: EVERY_PHASE, check: routeRule },
  { id: "H16", title: "Mission aborted", phases: PRE_EXECUTION, check: missionAbortRule },
  { id: "H17", title: "Proposal lifetime", phases: ["submit"], check: lifetimeRule },
  { id: "H18", title: "Person clearance", phases: PRE_EXECUTION, check: personClearanceRule },
  { id: "H19", title: "Extinguishing agent", phases: EVERY_PHASE, check: agentRule },
];

/** Every finding of every rule that applies in the input's phase; empty when the proposal is valid. */
export function validateProposal(input: RuleInput): Finding[] {
  return RULES.filter(rule => rule.phases.includes(input.phase)).flatMap(rule => rule.check(input));
}

export function finding(ruleId: string, reason: string, evidenceIds?: readonly ObservationId[]): Finding {
  return evidenceIds && evidenceIds.length > 0 ? { ruleId, reason, evidenceIds: [...new Set(evidenceIds)] } : { ruleId, reason };
}

/**
 * A contingency maneuver: exempt from the time box and envelope hard-limit checks, and (return and land
 * only) from the ambient and reserve checks. Only the harness itself creates proposals with the
 * "contingency" proposer (ActionHarness.startContingency); submit() refuses that label from callers.
 */
export function isContingencyAction(proposal: ActionProposal): boolean {
  return proposal.proposer === "contingency" && CONTINGENCY_KINDS.has(proposal.action.kind);
}

/** Latest assessment of a route, or null when the belief has none. */
export function findRoute(ctx: HarnessContext, routeId: RouteId): RouteAssessment | null {
  let latest: RouteAssessment | null = null;
  for (const route of ctx.belief.routes) {
    if (route.id === routeId && (latest === null || route.assessedTick >= latest.assessedTick)) latest = route;
  }
  return latest;
}

/* H0 identity. */

function identityRule({ proposal, ctx }: RuleInput): Finding[] {
  if (proposal.aircraftId === ctx.profile.id) return [];
  return [finding("H0", `The proposal names aircraft ${proposal.aircraftId}, but this harness controls ${ctx.profile.id}.`)];
}

/* H1 capability. */

function capabilityRule({ proposal, ctx }: RuleInput): Finding[] {
  const missing = missingCapability(proposal.action, ctx);
  return missing ? [finding("H1", `${ctx.profile.name} cannot ${missing}.`)] : [];
}

function missingCapability(action: ActionSpec, ctx: HarnessContext): string | null {
  const modules = ctx.profile.modules;
  switch (action.kind) {
    case "spray":
      return modules.water ? null : "spray water: it has no water module";
    case "breach_opening":
      return modules.glassBreaker ? null : "break glass: it has no glass breaker";
    case "release_payload":
      return payloadProblem(action.payloadId, ctx);
    case "speak":
      return modules.speaker ? null : "speak: it has no speaker";
    case "guide":
      return modules.lightCue || modules.speaker ? null : "guide: it has neither a light cue nor a speaker";
    default:
      return null;
  }
}

function payloadProblem(payloadId: string, ctx: HarnessContext): string | null {
  if (!ctx.profile.modules.payloadBay) return "release a payload: it has no payload bay";
  if (!ctx.belief.aircraft.payloadsOnboard.includes(payloadId)) return `release payload ${payloadId}: it is not onboard`;
  return null;
}

/* H2 limits. */

function limitsRule(input: RuleInput): Finding[] {
  return [...sprayLimits(input), ...breachReach(input), ...holdLimit(input), ...ambientLimit(input), ...reserveLimit(input)];
}

function sprayLimits({ phase, proposal, ctx }: RuleInput): Finding[] {
  const action = proposal.action;
  const water = ctx.profile.modules.water;
  if (action.kind !== "spray" || !water) return [];
  const findings: Finding[] = [];
  if (!(action.flowLps <= water.maxFlowLps)) {
    findings.push(finding("H2", `Flow ${fmt(action.flowLps)} L/s exceeds the water module's ${fmt(water.maxFlowLps)} L/s maximum.`));
  }
  findings.push(...reactionFindings(action, ctx));
  if (phase !== "monitor") findings.push(...doseAndAimFindings(action, ctx));
  return findings;
}

function reactionFindings(action: SpraySpec, ctx: HarnessContext): Finding[] {
  const water = ctx.profile.modules.water;
  if (!water) return [];
  const limits = ctx.profile.hardLimits;
  const marginN = ctx.belief.aircraft.thrustAvailableN - limits.hoverThrustN;
  const allowedN = limits.maxReactionFractionOfMargin * marginN;
  const reactionN = jetReactionN(action.flowLps, water.nozzleDiameterMm);
  if (reactionN <= allowedN) return [];
  return [finding("H2", `Jet reaction ${fmt(reactionN)} N exceeds the allowed ${fmt(Math.max(0, allowedN))} N (${fmt(limits.maxReactionFractionOfMargin)} of the ${fmt(marginN)} N thrust margin).`)];
}

function doseAndAimFindings(action: SpraySpec, ctx: HarnessContext): Finding[] {
  const water = ctx.profile.modules.water;
  if (!water) return [];
  const findings: Finding[] = [];
  const doseL = sprayDoseL(action);
  const remainingL = ctx.belief.aircraft.waterRemainingL;
  if (remainingL === null) findings.push(finding("H2", "Remaining water is unknown, so the dose cannot be checked."));
  else if (!(doseL <= remainingL)) findings.push(finding("H2", `Dose ${fmt(doseL)} L exceeds the ${fmt(remainingL)} L of water remaining (or either is not a number).`));
  const reachM = distance(action.standoff, action.aimPoint);
  if (!(reachM >= MIN_AIM_DISTANCE_M)) findings.push(finding("H2", "The aim point coincides with the standoff, so the jet has no direction."));
  else if (!(reachM <= water.rangeM)) findings.push(finding("H2", `The aim point is ${fmt(reachM)} m from the standoff, beyond the ${fmt(water.rangeM)} m jet range.`));
  return findings;
}

function breachReach({ phase, proposal, ctx }: RuleInput): Finding[] {
  const action = proposal.action;
  const breaker = ctx.profile.modules.glassBreaker;
  if (phase === "monitor" || action.kind !== "breach_opening" || !breaker) return [];
  const reachM = distance(action.standoff, action.strikePoint);
  if (reachM <= breaker.reachM) return [];
  return [finding("H2", `The strike point is ${fmt(reachM)} m from the standoff, beyond the glass breaker's ${fmt(breaker.reachM)} m reach.`)];
}

function holdLimit({ phase, proposal, ctx }: RuleInput): Finding[] {
  const action = proposal.action;
  if (phase === "monitor" || action.kind !== "hold" || action.durationTicks <= ctx.policy.maxHoldTicks) return [];
  return [finding("H2", `A hold of ${action.durationTicks} ticks exceeds the ${ctx.policy.maxHoldTicks}-tick bounded hold.`)];
}

/**
 * A contingency return or landing is how the aircraft leaves conditions beyond its limits, so neither is
 * blocked by them. A contingency hold stays where it is, so it needs the same support as any hold: a known
 * ambient within limits and endurance above the reserve (the conditions the selector bounded it by).
 */
function exemptFromSupportLimits(proposal: ActionProposal): boolean {
  return isContingencyAction(proposal) && proposal.action.kind !== "hold";
}

function ambientLimit({ proposal, ctx }: RuleInput): Finding[] {
  if (exemptFromSupportLimits(proposal)) return [];
  const ambientC = ctx.belief.aircraft.ambientC;
  const limitC = Math.min(ctx.profile.hardLimits.maxAmbientC, ctx.envelope.ambientCeilingC);
  if (ambientC === null) return [finding("H2", "Ambient temperature is unknown; mission actions need a reading within limits.")];
  if (ambientC <= limitC) return [];
  return [finding("H2", `Ambient ${fmt(ambientC)} °C exceeds the ${fmt(limitC)} °C limit (aircraft hard limit or envelope ceiling).`)];
}

/** Actions that spend the return reserve by design (they end the flight) need not keep it. */
const RESERVE_EXEMPT: ReadonlySet<ActionKind> = new Set<ActionKind>(["return", "land"]);

function reserveLimit({ phase, proposal, ctx }: RuleInput): Finding[] {
  if (exemptFromSupportLimits(proposal) || RESERVE_EXEMPT.has(proposal.action.kind)) return [];
  const remainingS = ctx.belief.aircraft.enduranceRemainingS;
  const reserveS = ctx.profile.hardLimits.returnReserveS;
  if (phase === "monitor") {
    return remainingS >= reserveS ? [] : [finding("H2", `Endurance ${fmt(remainingS)} s has reached the ${fmt(reserveS)} s return reserve.`)];
  }
  const durationS = estimatedDurationS(proposal, ctx);
  if (remainingS - durationS >= reserveS) return [];
  return [finding("H2", `Endurance ${fmt(remainingS)} s minus the action's estimated ${fmt(durationS)} s would leave less than the ${fmt(reserveS)} s return reserve.`)];
}

/** Conservative duration estimate used for the reserve check. */
export function estimatedDurationS(proposal: ActionProposal, ctx: HarnessContext): number {
  const action = proposal.action;
  switch (action.kind) {
    case "spray":
    case "scan":
    case "hold":
      return secondsFromTicks(action.durationTicks);
    case "guide":
      return secondsFromTicks(action.maxDurationTicks);
    case "breach_opening":
      return secondsFromTicks(ctx.profile.modules.glassBreaker?.strikeDelayTicks ?? 0);
    case "move":
      return travelS(ctx, action.goal, Math.min(action.maxSpeedMps, ctx.envelope.maxSpeedMps, ctx.profile.hardLimits.maxSpeedMps));
    case "land":
      return travelS(ctx, action.site, Math.min(ctx.envelope.maxSpeedMps, ctx.profile.hardLimits.maxVerticalSpeedMps));
    case "return":
      return findRoute(ctx, action.routeId)?.estimatedDurationS ?? Infinity;
    default:
      return 0;
  }
}

function travelS(ctx: HarnessContext, target: Vec3, speedMps: number): number {
  return distance(ctx.belief.pose.position, target) / Math.max(speedMps, 1e-6);
}

/* H3 envelope. */

function envelopeRule({ proposal, ctx, state }: RuleInput): Finding[] {
  const envelope = ctx.envelope;
  const findings: Finding[] = [];
  if (envelope.runId !== state.runId) findings.push(finding("H3", `The mission envelope belongs to run ${envelope.runId}, not ${state.runId}.`));
  if (!isContingencyAction(proposal)) {
    for (const violation of hardLimitViolations(envelope, ctx.profile, ctx.missionStartTick)) {
      findings.push(finding("H3", `The mission envelope exceeds aircraft hard limits: ${violation}`));
    }
    if (ctx.tick > envelope.endTick) findings.push(finding("H3", `The envelope time box ended at tick ${envelope.endTick}; only contingencies remain available.`));
  }
  const sigmaM = ctx.belief.pose.sigmaM;
  const positions = actionPositions(proposal.action, ctx);
  if (!(sigmaM >= 0 && Number.isFinite(sigmaM)) && positions.length > 0) {
    findings.push(finding("H3", `Pose uncertainty ${fmt(sigmaM)} m is not a finite non-negative number, so no position can be checked against the envelope.`));
  } else {
    for (const [label, point] of positions) {
      if (!envelopeContains(envelope, point, sigmaM)) {
        findings.push(finding("H3", `${label} ${fmtVec(point)} is outside envelope revision ${envelope.revision} (with ${fmt(sigmaM)} m pose uncertainty). Expanding the envelope is a separate mission revision.`));
      }
    }
  }
  if (proposal.action.kind === "move" && !(proposal.action.maxSpeedMps <= envelope.maxSpeedMps)) {
    findings.push(finding("H3", `Requested speed ${fmt(proposal.action.maxSpeedMps)} m/s exceeds the envelope's ${fmt(envelope.maxSpeedMps)} m/s.`));
  }
  return findings;
}

/** Every position the action would fly to or act at, including each waypoint of a return or guide route (H15 reports a missing route). */
function actionPositions(action: ActionSpec, ctx: HarnessContext): [string, Vec3][] {
  switch (action.kind) {
    case "return":
    case "guide":
      return (findRoute(ctx, action.routeId)?.waypoints ?? []).map((point, i): [string, Vec3] => [`Route ${action.routeId} waypoint ${i}`, point]);
    case "move":
      return [["Goal", action.goal]];
    case "land":
      return [["Landing site", action.site]];
    case "spray":
    case "breach_opening":
      return [["Standoff", action.standoff]];
    case "release_payload":
      return [["Release point", action.releasePoint]];
    default:
      return [];
  }
}

/* H4 basis and evidence. */

function basisRule(input: RuleInput): Finding[] {
  return [...revisionFindings(input), ...citedEvidenceFindings(input), ...mapChangeFindings(input)];
}

function revisionFindings({ proposal, ctx, state }: RuleInput): Finding[] {
  const basis = proposal.basis;
  const belief = ctx.belief;
  const checks: [boolean, string][] = [
    [belief.runId !== state.runId, `The belief snapshot belongs to run ${belief.runId}, not ${state.runId}.`],
    [basis.profileRevision !== ctx.profile.revision, `The proposal relied on aircraft profile revision ${basis.profileRevision}; the current revision is ${ctx.profile.revision}.`],
    [basis.envelopeRevision !== ctx.envelope.revision, `The proposal relied on envelope revision ${basis.envelopeRevision}; the current revision is ${ctx.envelope.revision}.`],
    [basis.policyRevision !== ctx.policy.revision, `The proposal relied on harness policy revision ${basis.policyRevision}; the current revision is ${ctx.policy.revision}.`],
    [basis.evidenceRevision > belief.evidenceRevision, `The proposal cites evidence revision ${basis.evidenceRevision}, newer than the belief's ${belief.evidenceRevision}.`],
    [basis.mapRevision > belief.mapRevision, `The proposal cites map revision ${basis.mapRevision}, newer than the belief's ${belief.mapRevision}.`],
  ];
  return checks.filter(([failed]) => failed).map(([, reason]) => finding("H4", reason));
}

function citedEvidenceFindings({ phase, proposal, ctx }: RuleInput): Finding[] {
  const preExecution = phase !== "monitor";
  const findings: Finding[] = [];
  if (preExecution && riskClassOf(proposal.action.kind) === "consequential" && proposal.citedEvidence.length === 0) {
    findings.push(finding("H4", "A consequential action must cite at least one observation."));
  }
  // A contingency's support is re-checked against current belief by H10 and H15 (and every tick while it
  // executes), so a citation that has merely left the bounded observation window must not block the escape
  // maneuver. A superseded citation still blocks: that is an affirmative replacement of the evidence.
  const checkPresenceAndAge = preExecution && !isContingencyAction(proposal);
  for (const id of proposal.citedEvidence) {
    // A guide cites its route's evidence, which may be as old as the route evidence limit (H15 applies it).
    const maxAge = proposal.action.kind === "guide" ? ctx.policy.routeEvidenceMaxAgeTicks : ctx.policy.citedEvidenceMaxAgeTicks;
    const problem = citedProblem(id, ctx, checkPresenceAndAge, maxAge);
    if (problem) findings.push(problem);
  }
  return findings;
}

function citedProblem(id: ObservationId, ctx: HarnessContext, checkPresenceAndAge: boolean, maxAgeTicks: Tick = ctx.policy.citedEvidenceMaxAgeTicks): Finding | null {
  const observations = ctx.belief.observations;
  const successor = observations.find(o => o.supersedes === id);
  if (successor) return finding("H4", `Cited observation ${id} was superseded by ${successor.id}.`, [id, successor.id]);
  if (!checkPresenceAndAge) return null;
  const cited = observations.find(o => o.id === id);
  if (!cited) return finding("H4", `Cited observation ${id} is not in the current evidence.`, [id]);
  const ageTicks = ctx.tick - cited.captureTick;
  if (ageTicks <= maxAgeTicks) return null;
  return finding("H4", `Cited observation ${id} is ${ageTicks} ticks old; cited evidence may be at most ${maxAgeTicks} ticks old.`, [id]);
}

function mapChangeFindings({ proposal, ctx }: RuleInput): Finding[] {
  const region = dependencyRegion(proposal.action, ctx.profile, ctx.belief.mapPrior);
  if (!region) return [];
  return ctx.belief.mapChanges
    .filter(change => change.revision > proposal.basis.mapRevision && regionsOverlap(change.region, region))
    .map(change => finding("H4", `Map revision ${change.revision} changed the action's region after its basis (${change.reason}).`, change.observationIds));
}

/* H5 approval binding. */

function approvalRule({ proposal, ctx, state, status, approval }: RuleInput): Finding[] {
  if (riskClassOf(proposal.action.kind) !== "consequential") return [];
  if (status !== "approved" || !approval) return [finding("H5", "This consequential action has no individual commander approval.")];
  const checks: [boolean, string][] = [
    [approval.proposalId !== proposal.id || approval.digest !== proposal.digest, "The approval does not bind this exact proposal."],
    [approval.runId !== state.runId, `The approval belongs to run ${approval.runId}, not ${state.runId}.`],
    [ctx.tick > approval.expiresTick, `The approval expired at tick ${approval.expiresTick}.`],
  ];
  return checks.filter(([failed]) => failed).map(([, reason]) => finding("H5", reason));
}

/* H6 affected-region safety. */

function regionSafetyRule({ proposal, ctx }: RuleInput): Finding[] {
  const action = proposal.action;
  if (!INTERVENTION_KINDS.has(action.kind)) return [];
  const region = cachedAffectedRegion(action, ctx);
  const opens = action.kind === "breach_opening" ? [action.openingId] : [];
  const falling = action.kind === "breach_opening" || action.kind === "release_payload";
  const marginOrigin = action.kind === "breach_opening" ? action.standoff : undefined;
  if (region) {
    const coverage = action.kind === "breach_opening" ? breachCoverageFindings(action, region, ctx) : coverageFindings(region, ctx, opens, falling, marginOrigin);
    return [...coverage, ...detectionFindings(region, ctx), ...trackFindings(region, ctx)];
  }
  const derivable = action.kind === "spray" && ctx.profile.modules.water !== null;
  return derivable ? [finding("H6", "The discharge region cannot be derived from this aim, so its safety cannot be checked.")] : [];
}

const regionCache = new WeakMap<ActionSpec, { readonly profile: HarnessContext["profile"]; readonly prior: HarnessContext["belief"]["mapPrior"]; readonly region: Region | null }>();

/**
 * The affected region for this action, profile and prior. Monitoring re-derives it every tick; reusing the
 * same region object lets the coverage sampler reuse its memoized samples.
 */
function cachedAffectedRegion(action: ActionSpec, ctx: HarnessContext): Region | null {
  const cached = regionCache.get(action);
  if (cached && cached.profile === ctx.profile && cached.prior === ctx.belief.mapPrior) return cached.region;
  const region = affectedRegion(action, ctx.profile, ctx.belief.mapPrior);
  regionCache.set(action, { profile: ctx.profile, prior: ctx.belief.mapPrior, region });
  return region;
}

function coverageFindings(region: Region, ctx: HarnessContext, opensOpenings: readonly string[], falling: boolean, marginOrigin: Vec3 | undefined): Finding[] {
  const policy = ctx.policy;
  const coverage = coverageOf(region, ctx, opensOpenings, falling, marginOrigin);
  if (coverage.samples === 0) {
    return [finding("H6", "Coverage cannot be established: no sample of the affected region and its margin lies in occupiable space the action can reach according to the floor-plan prior, so the action is refused rather than assumed safe.")];
  }
  if (coverage.fraction >= policy.minCoverageFraction) return [];
  return [finding("H6", `Only ${pct(coverage.fraction)} of the occupiable, reachable part of the affected region and its ${fmt(policy.coverageMarginM)} m edge band has coverage from a person search in the last ${policy.coverageFreshTicks} ticks at quality ≥ ${fmt(policy.minCoverageQuality)}; ${pct(policy.minCoverageFraction)} is required. Missing or low-quality coverage is not evidence that the region is unoccupied.`)];
}

/**
 * A breach needs breachMinCoverageFraction of its debris region searched (not the spray's fraction) and its
 * target opening observed within coverageFreshTicks; H14 separately requires that observation to show the
 * opening closed. The commander always sees how much was searched and where the unseen part lies.
 */
function breachCoverageFindings(action: BreachSpec, region: Region, ctx: HarnessContext): Finding[] {
  const findings: Finding[] = [];
  const latest = latestOpeningEvidence(action.openingId, ctx);
  if (latest && !(latest.tick >= ctx.tick - ctx.policy.coverageFreshTicks)) {
    findings.push(finding("H6", `Opening ${action.openingId} was last observed at tick ${latest.tick}, more than ${ctx.policy.coverageFreshTicks} ticks ago; look at it again before breaking it.`, [latest.observationId]));
  }
  const assessment = breachCoverageAssessment(action, region, ctx);
  if (assessment.samples === 0) {
    findings.push(finding("H6", "Coverage cannot be established: no sample of the debris region lies in occupiable space the debris can reach according to the floor-plan prior, so the breach is refused rather than assumed safe."));
  } else if (!(assessment.fraction >= ctx.policy.breachMinCoverageFraction)) {
    findings.push(finding("H6", `${assessment.text} ${pct(ctx.policy.breachMinCoverageFraction)} is required for a breach: look first. Missing coverage is not evidence that the region is unoccupied.`));
  }
  return findings;
}

export interface BreachCoverageAssessment {
  readonly fraction: number;
  readonly samples: number;
  /** Unseen required samples by coarse place, largest group first. */
  readonly unseen: readonly { readonly place: string; readonly samples: number }[];
  /** Plain-language disclosure for the commander. */
  readonly text: string;
}

/**
 * How much of a breach's debris region a fresh person search covered and where the unseen required samples
 * lie, grouped coarsely relative to the pane (the PRD's explicit modeled effects for the coverage gap).
 */
export function breachCoverageAssessment(action: BreachSpec, region: Region, ctx: HarnessContext): BreachCoverageAssessment {
  const coverage = coverageOf(region, ctx, [action.openingId], true, action.standoff);
  const opening = ctx.belief.mapPrior.openings.find(o => o.id === action.openingId) ?? null;
  const groups = new Map<string, number>();
  for (const point of coverage.uncovered) {
    const place = unseenPlace(point, opening);
    groups.set(place, (groups.get(place) ?? 0) + 1);
  }
  const unseen = [...groups.entries()].map(([place, samples]) => ({ place, samples })).sort((a, b) => b.samples - a.samples || (a.place < b.place ? -1 : 1));
  const where = unseen.length === 0 ? "No required part is unseen." : `Unseen: ${unseen.map(g => `${g.place} (${g.samples})`).join(", ")}.`;
  const text = `Debris region coverage: ${pct(coverage.fraction)} of ${coverage.samples} required samples (occupiable, reachable, up to standing height) searched for people in the last ${ctx.policy.coverageFreshTicks} ticks at quality ≥ ${fmt(ctx.policy.minCoverageQuality)}. ${where}`;
  return { fraction: coverage.fraction, samples: coverage.samples, unseen, text };
}

/** A coarse place relative to the pane: which side, then under the sill, beside the frame, above the pane or in front of it. */
function unseenPlace(point: Vec3, opening: HarnessContext["belief"]["mapPrior"]["openings"][number] | null): string {
  if (opening === null) return "near the strike point";
  const n = opening.outwardNormal;
  const horizontal = Math.hypot(n.x, n.y);
  if (!(horizontal > 1e-6)) return "near the opening";
  const nx = n.x / horizontal;
  const ny = n.y / horizontal;
  const dx = point.x - opening.center.x;
  const dy = point.y - opening.center.y;
  const side = dx * nx + dy * ny >= 0 ? "outside" : "inside";
  const lateralM = Math.abs(-dx * ny + dy * nx);
  const sillZ = opening.center.z - opening.heightM / 2;
  const topZ = opening.center.z + opening.heightM / 2;
  if (point.z < sillZ) return side === "inside" ? "inside under the sill" : "outside at the wall base";
  if (lateralM > opening.widthM / 2) return `${side} beside the frame`;
  if (point.z > topZ) return side === "inside" ? "inside above the pane, toward the ceiling" : "outside above the pane";
  return `${side} in front of the pane`;
}

function detectionFindings(region: Region, ctx: HarnessContext): Finding[] {
  const findings: Finding[] = [];
  for (const observation of ctx.belief.observations) {
    for (const detection of observation.detections) {
      if (detection.kind !== "possible_person") continue;
      const distanceM = blockingDistance(region, detection.position, detection.uncertaintyM, detection.confidence, observation.captureTick, ctx);
      if (distanceM === null) continue;
      findings.push(finding("H6", `Possible person in observation ${observation.id} (confidence ${fmt(detection.confidence)}, ±${fmt(detection.uncertaintyM)} m) is ${fmt(distanceM)} m from the affected region, inside its uncertainty plus the ${fmt(ctx.policy.personMarginM)} m margin.`, [observation.id]));
    }
  }
  return findings;
}

function trackFindings(region: Region, ctx: HarnessContext): Finding[] {
  return ctx.belief.tracks.flatMap(track => {
    if (track.status !== "possible") return [];
    const distanceM = blockingDistance(region, track.position, track.uncertaintyM, track.confidence, track.lastSeenTick, ctx);
    if (distanceM === null) return [];
    return [finding("H6", `Possible-occupant track ${track.id} (confidence ${fmt(track.confidence)}, ±${fmt(track.uncertaintyM)} m) is ${fmt(distanceM)} m from the affected region, inside its uncertainty plus the ${fmt(ctx.policy.personMarginM)} m margin.`, track.observationIds)];
  });
}

/** Distance from a possible person to the region when it blocks the action; null when it does not. */
function blockingDistance(region: Region, position: Vec3, uncertaintyM: number, confidence: number, seenTick: Tick, ctx: HarnessContext): number | null {
  if (confidence < ctx.policy.personConfidenceThreshold) return null;
  const distanceM = distanceToRegion(region, position);
  if (distanceM > uncertaintyM + ctx.policy.personMarginM) return null;
  return clearedByLaterLook(position, uncertaintyM, seenTick, ctx) ? null : distanceM;
}

/* H8 truthful speech. */

function speechRule({ proposal, ctx }: RuleInput): Finding[] {
  const action = proposal.action;
  const templateIds = action.kind === "speak" ? [action.templateId] : action.kind === "guide" ? action.templateIds : [];
  return templateIds.flatMap(id => {
    const template = SPEECH_TEMPLATES.find(t => t.id === id);
    if (!template) return [finding("H8", `Speech template "${id}" is not an approved scenario template.`)];
    if (template.requiresDispatchConfirmed && !ctx.belief.dispatchConfirmed) {
      return [finding("H8", `Template "${id}" mentions dispatch, which the commander has not confirmed.`)];
    }
    return [];
  });
}

/* H10 localization. */

const ADVANCE_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>(["move", "scan", "hold", "return", "guide"]);

function localizationRule(input: RuleInput): Finding[] {
  const { proposal, ctx } = input;
  const kind = proposal.action.kind;
  if (kind === "land") return landingFindings(input);
  const intervention = INTERVENTION_KINDS.has(kind);
  if (!intervention && !ADVANCE_KINDS.has(kind)) return [];
  const pose = ctx.belief.pose;
  if (!pose.supported) return [finding("H10", "Localization does not currently support this action.")];
  const limitM = intervention ? ctx.policy.maxSigmaForInterventionM : ctx.policy.maxSigmaForAdvanceM;
  // A negative or NaN σ is not an estimate of uncertainty; it fails like an excessive one.
  if (pose.sigmaM >= 0 && pose.sigmaM <= limitM) return [];
  return [finding("H10", `Pose uncertainty ${fmt(pose.sigmaM)} m exceeds the ${fmt(limitM)} m allowed for ${intervention ? "an intervention" : "movement"}.`)];
}

function landingFindings({ phase, proposal, ctx }: RuleInput): Finding[] {
  const landing = ctx.belief.landing;
  if (!landing.supported) return [finding("H10", `Landing is not supported: ${landing.reason}`, landing.evidenceIds)];
  if (phase === "monitor" || proposal.action.kind !== "land") return [];
  const site = proposal.action.site;
  if (!(landing.site && distance(landing.site, site) <= ctx.policy.standoffToleranceM)) {
    return [finding("H10", `The supported landing site does not match the proposed site ${fmtVec(site)}.`, landing.evidenceIds)];
  }
  const inPlace = landInPlaceProblem(site, ctx);
  return inPlace ? [finding("H10", inPlace, landing.evidenceIds)] : [];
}

/**
 * Without supported localization the motion guard allows only a vertical descent where the aircraft is,
 * so a landing is only a landing on the supported site when that site lies under the aircraft: within the
 * pose uncertainty, horizontally, of the estimated position. Null when the landing is acceptable.
 */
export function landInPlaceProblem(site: Vec3, ctx: HarnessContext): string | null {
  if (localizationSupportsAdvance(ctx)) return null;
  const pose = ctx.belief.pose;
  const sigmaM = pose.sigmaM;
  const offsetM = Math.hypot(site.x - pose.position.x, site.y - pose.position.y);
  if (sigmaM >= 0 && offsetM <= sigmaM) return null;
  return `Localization does not support movement, so only a descent in place is possible, but the landing site ${fmtVec(site)} is ${fmt(offsetM)} m horizontally from the estimated position, beyond the ${fmt(sigmaM)} m pose uncertainty.`;
}

/* H11 monitored standoff. */

function standoffRule({ proposal, ctx }: RuleInput): Finding[] {
  const station = stationPoint(proposal.action);
  if (!station) return [];
  const offsetM = distance(ctx.belief.pose.position, station);
  if (offsetM <= ctx.policy.standoffToleranceM) return [];
  return [finding("H11", `The aircraft is ${fmt(offsetM)} m from the action's standoff; the tolerance is ${fmt(ctx.policy.standoffToleranceM)} m.`)];
}

function stationPoint(action: ActionSpec): Vec3 | null {
  if (action.kind === "spray" || action.kind === "breach_opening") return action.standoff;
  if (action.kind === "release_payload") return action.releasePoint;
  return null;
}

/* H14 purpose. */

function purposeRule({ proposal, ctx, state }: RuleInput): Finding[] {
  const action = proposal.action;
  if (action.kind === "spray") return fireFindings(action, ctx, state.sprays, proposal.id);
  if (action.kind === "breach_opening") return openingFindings(action, ctx);
  return [];
}

/**
 * A spray needs a fire observed burning in its discharge sector. Intensity 0 is a camera's report of the place
 * with no flame (a fire that is out): it is not a fire to suppress, and a flame sighting with a later no-flame
 * sighting of the same place no longer counts. A flame sighting captured before an earlier spray that reached
 * it had ended no longer counts either (respray.ts): water has landed since, so only a new sighting that still
 * shows flame supports another spray.
 */
function fireFindings(action: SpraySpec, ctx: HarnessContext, sprays: readonly SprayDischarge[], proposalId: ProposalId): Finding[] {
  const water = ctx.profile.modules.water;
  const region = water ? sprayRegion(action, water) : null;
  if (!water || !region) return [];
  const freshFrom = ctx.tick - ctx.policy.citedEvidenceMaxAgeTicks;
  const sightings = ctx.belief.hazards.filter(h => h.hazard === "fire" && h.tick >= freshFrom && regionsOverlap(h.region, region));
  const seenOut = sightings.filter(h => !(h.intensity > 0));
  const burning = sightings.filter(h => h.intensity > 0 && !seenOut.some(o => (o.tick > h.tick || (o.tick === h.tick && o.observationId > h.observationId)) && regionsOverlap(o.region, h.region)));
  // Newest first: the sighting most likely to postdate every spray is checked first.
  let sprayed: { readonly h: HazardEvidence; readonly spray: SprayDischarge } | null = null;
  for (const h of [...burning].sort((a, b) => b.tick - a.tick)) {
    const spray = sprayAfterSighting(sprays, h, water, proposalId);
    if (spray === null) return [];
    sprayed ??= { h, spray };
  }
  if (sprayed !== null) {
    const ended = sprayed.spray.endedTick === null ? "is still discharging" : `ended at tick ${sprayed.spray.endedTick}`;
    return [finding("H14", `The fire in the discharge sector was last seen burning at tick ${sprayed.h.tick}, before spray proposal ${sprayed.spray.proposalId}, which reached it, ${ended}. Look at it again first: only a sighting captured after that spray that still shows flame supports another spray.`, burning.slice(-4).map(h => h.observationId))];
  }
  if (seenOut.length > 0) return [finding("H14", "The latest observations of the fire in the discharge sector show no flame; there is no fire to suppress.", seenOut.slice(-4).map(h => h.observationId))];
  return [finding("H14", "No recent fire observation overlaps the discharge sector; spraying needs an observed fire to suppress.")];
}

function openingFindings(action: BreachSpec, ctx: HarnessContext): Finding[] {
  const opening = ctx.belief.mapPrior.openings.find(o => o.id === action.openingId);
  if (!opening) return [finding("H14", `Opening ${action.openingId} is not in the floor-plan prior.`)];
  const findings: Finding[] = [];
  const extentM = Math.hypot(opening.widthM, opening.heightM) / 2 + ctx.policy.standoffToleranceM;
  if (distance(action.strikePoint, opening.center) > extentM) {
    findings.push(finding("H14", `The strike point ${fmtVec(action.strikePoint)} is not on opening ${action.openingId}.`));
  }
  const stateProblem = openingStateProblem(action.openingId, ctx);
  if (stateProblem) findings.push(stateProblem);
  return findings;
}

function openingStateProblem(openingId: OpeningId, ctx: HarnessContext): Finding | null {
  const latest = latestOpeningEvidence(openingId, ctx);
  if (!latest) return finding("H14", `No observation shows opening ${openingId} closed.`);
  if (latest.state === "open" || latest.state === "broken") {
    return finding("H14", `Opening ${openingId} was observed ${latest.state}; use the observed opening instead.`, [latest.observationId]);
  }
  if (latest.state === "blocked") return finding("H14", `Opening ${openingId} was observed blocked; breaking its glass would not create access.`, [latest.observationId]);
  if (latest.tick < ctx.tick - ctx.policy.citedEvidenceMaxAgeTicks) {
    return finding("H14", `Opening ${openingId} was last observed closed at tick ${latest.tick}, too long ago to support breaking it.`, [latest.observationId]);
  }
  return null;
}

function latestOpeningEvidence(openingId: OpeningId, ctx: HarnessContext): OpeningEvidence | null {
  let latest: OpeningEvidence | null = null;
  for (const evidence of ctx.belief.openings) {
    if (evidence.openingId === openingId && (latest === null || evidence.tick >= latest.tick)) latest = evidence;
  }
  return latest;
}

/* H15 routes. */

function routeRule(input: RuleInput): Finding[] {
  const action = input.proposal.action;
  if (action.kind === "guide") return guideRouteFindings(input, action.routeId, action.trackId);
  if (action.kind === "return") return returnRouteFindings(input, action.routeId);
  return [];
}

function guideRouteFindings({ phase, ctx, state }: RuleInput, routeId: RouteId, trackId: TrackId): Finding[] {
  const route = findRoute(ctx, routeId);
  // Under way, guidance stops on affirmative evidence of a blocker (the route assessed "unsupported": fire on
  // its corridor, an opening seen blocked), not because its evidence has aged into "unknown": the aircraft is
  // leading along the route and re-observing it, as cited evidence is not re-aged while an action is monitored.
  const problems = !route
    ? [`Evacuation route ${routeId} has no current assessment.`]
    : phase === "monitor"
      ? monitoredRouteProblems(route, ctx, state)
      : evacuationRouteProblems(route, ctx, state);
  const prefix = phase === "monitor" ? "Route no longer supported: " : "";
  const findings = problems.map(problem => finding("H15", `${prefix}${problem}`, route?.evidenceIds));
  const track = ctx.belief.tracks.find(t => t.id === trackId);
  if (!track || track.status !== "possible") findings.push(finding("H15", `Track ${trackId} is not a current possible occupant, so there is no one to guide.`));
  return findings;
}

/**
 * While guidance runs: the route assessed unsupported (affirmative evidence of a blocker), or citing an
 * observation captured before the latest intervention (an intervention since makes it outdated). Evidence that
 * has merely aged out of the window is not a reason to stop a guided evacuation under way.
 */
function monitoredRouteProblems(route: RouteAssessment, ctx: HarnessContext, state: RuleState): string[] {
  const after = state.lastInterventionTick;
  const problems = route.status === "unsupported" ? [`Route ${route.id} is unsupported: ${route.reason}`] : [];
  if (after === null) return problems;
  for (const id of route.evidenceIds) {
    const cited = ctx.belief.observations.find(o => o.id === id);
    if (cited && !(cited.captureTick > after)) problems.push(`Route ${route.id} cites observation ${id} captured at tick ${cited.captureTick}, not after the intervention at tick ${after}.`);
  }
  return problems;
}

function evacuationRouteProblems(route: RouteAssessment, ctx: HarnessContext, state: RuleState): string[] {
  const after = state.lastInterventionTick;
  const checks: [boolean, string][] = [
    [route.purpose !== "evacuation", `Route ${route.id} is a ${route.purpose} route, not an evacuation route.`],
    [route.status !== "supported", `Route ${route.id} is ${route.status}: ${route.reason}`],
    [!(route.assessedTick >= ctx.tick - ctx.policy.routeFreshTicks), `Route ${route.id} was assessed at tick ${route.assessedTick}, more than ${ctx.policy.routeFreshTicks} ticks ago.`],
    [after !== null && !(route.assessedTick > after), `Route ${route.id} was assessed at tick ${route.assessedTick}, not after the intervention at tick ${after}; guidance needs an assessment of the changed conditions.`],
    [route.waypoints.length === 0, `Route ${route.id} has no waypoints.`],
  ];
  return [...checks.filter(([failed]) => failed).map(([, reason]) => reason), ...routeEvidenceProblems(route, ctx, after)];
}

/**
 * The assessment's tick is the assessor's claim; its evidence is what supports it. Every cited observation
 * must be in the current belief, captured within the cited-evidence age limit and after the latest
 * intervention, and at least one must be cited.
 */
function routeEvidenceProblems(route: RouteAssessment, ctx: HarnessContext, after: Tick | null): string[] {
  if (route.evidenceIds.length === 0) return [`Route ${route.id} cites no observation.`];
  const oldest = ctx.tick - ctx.policy.routeEvidenceMaxAgeTicks;
  return route.evidenceIds.flatMap(id => {
    const cited = ctx.belief.observations.find(o => o.id === id);
    if (!cited) return [`Route ${route.id} cites observation ${id}, which is not in the current evidence.`];
    if (!(cited.captureTick >= oldest)) return [`Route ${route.id} cites observation ${id} captured at tick ${cited.captureTick}, more than ${ctx.policy.routeEvidenceMaxAgeTicks} ticks ago.`];
    if (after !== null && !(cited.captureTick > after)) return [`Route ${route.id} cites observation ${id} captured at tick ${cited.captureTick}, not after the intervention at tick ${after}.`];
    return [];
  });
}

function returnRouteFindings({ ctx }: RuleInput, routeId: RouteId): Finding[] {
  const route = findRoute(ctx, routeId);
  if (!route) return [finding("H15", `Return route ${routeId} has no current assessment.`)];
  const checks: [boolean, string][] = [
    [route.purpose === "evacuation", `Route ${route.id} is an evacuation route, not a return route.`],
    [route.status !== "supported", `Return route ${route.id} is ${route.status}: ${route.reason}`],
    [!(route.assessedTick >= ctx.tick - ctx.policy.returnRouteFreshTicks), `Return route ${route.id} was assessed at tick ${route.assessedTick}, more than ${ctx.policy.returnRouteFreshTicks} ticks ago.`],
    [route.waypoints.length === 0, `Return route ${route.id} has no waypoints.`],
  ];
  return checks.filter(([failed]) => failed).map(([, reason]) => finding("H15", reason, route.evidenceIds));
}

/* H16 mission aborted. */

function missionAbortRule({ proposal, state }: RuleInput): Finding[] {
  if (!state.missionAborted || isContingencyAction(proposal)) return [];
  return [finding("H16", "The mission was aborted; only contingency return, hold or land actions are accepted.")];
}

/* H17 proposal lifetime. */

function lifetimeRule({ proposal, ctx }: RuleInput): Finding[] {
  const maxLifetime = ctx.policy.maxProposalLifetimeTicks;
  const checks: [boolean, string][] = [
    [proposal.createdTick > ctx.tick, `The proposal was created at tick ${proposal.createdTick}, after the current tick ${ctx.tick}.`],
    [proposal.expiresTick < ctx.tick, `The proposal expired at tick ${proposal.expiresTick}, before it was submitted.`],
    [proposal.expiresTick - proposal.createdTick > maxLifetime, `The proposal lifetime of ${proposal.expiresTick - proposal.createdTick} ticks exceeds the ${maxLifetime}-tick maximum.`],
  ];
  return checks.filter(([failed]) => failed).map(([, reason]) => finding("H17", reason));
}

/* H18 person clearance. */

/**
 * A motion action may not fly to a goal, landing site or route waypoint that closes in on a current possible
 * occupant (person-clearance.ts): inside half the span plus policy.personClearanceM (guidanceClearanceM for a
 * guide) plus the occupant's uncertainty, and nearer the occupant than the aircraft already is. A hold or a
 * scan stays where it is and never closes in. A guide is checked on the waypoints it will lead along (from
 * guideLeadIndex on) against everyone but the person it guides, whose route starts beside them; the motion
 * guard keeps the guidance clearance from them every tick. Contingencies are exempt here — they may be
 * selected near people — but the motion guard keeps them from driving into anyone.
 */
function personClearanceRule({ proposal, ctx }: RuleInput): Finding[] {
  const action = proposal.action;
  if (!MOTION_KINDS.has(action.kind) || isContingencyAction(proposal)) return [];
  const targets = clearanceTargets(action, ctx);
  if (targets.length === 0) return [];
  const guided = action.kind === "guide" ? ctx.belief.tracks.find(t => t.id === action.trackId) ?? null : null;
  const guidedFrames = new Set(guided?.observationIds ?? []);
  const clearanceM = personClearanceFor(ctx, action.kind);
  const here = ctx.belief.pose.position;
  const findings: Finding[] = [];
  for (const occupant of possibleOccupants(ctx)) {
    if (guided && isGuidedPerson(occupant, guided, guidedFrames, ctx.belief.tracks)) continue;
    const requiredM = requiredPersonDistanceM(ctx, occupant.uncertaintyM, clearanceM);
    const closing = targets.filter(([, point]) => closesInOn(point, here, occupant.position, requiredM));
    if (closing.length === 0 || !isCurrentOccupant(occupant, ctx)) continue;
    const who = `${describeOccupant(occupant)} (confidence ${fmt(occupant.confidence)}, ±${fmt(occupant.uncertaintyM)} m)`;
    const keep = `${action.kind === "guide" ? "guidance" : "motion"} keeps ${fmt(clearanceM)} m from the aircraft's edge to a possible occupant, ${fmt(requiredM)} m from its centre with half its ${fmt(ctx.profile.spanM)} m span and the occupant's uncertainty`;
    for (const [label, point] of closing) {
      findings.push(finding("H18", `${label} ${fmtVec(point)} is ${fmt(distance(point, occupant.position))} m from ${who}, which is ${fmt(distance(here, occupant.position))} m from the aircraft now; ${keep}.`, occupant.evidenceIds));
    }
  }
  return findings;
}

/** Where a motion action flies to; a hold or a scan stays where it is, so it has none. */
function clearanceTargets(action: ActionSpec, ctx: HarnessContext): [string, Vec3][] {
  switch (action.kind) {
    case "move":
      return [["Goal", action.goal]];
    case "land":
      return [["Landing site", action.site]];
    case "return":
      return actionPositions(action, ctx);
    case "guide": {
      const waypoints = findRoute(ctx, action.routeId)?.waypoints ?? [];
      const track = ctx.belief.tracks.find(t => t.id === action.trackId);
      const from = track && waypoints.length > 0 ? guideLeadIndex(waypoints, track, ctx) : 0;
      return waypoints.slice(from).map((point, i): [string, Vec3] => [`Route ${action.routeId} waypoint ${from + i}`, point]);
    }
    default:
      return [];
  }
}

/* H19 extinguishing agent. */

/** The aim point is assessed as a place of this radius, so a spray with no fire sighting is still assessed where it lands. */
const AIM_PLACE_RADIUS_M = 0.1;
/** Fire sightings are assessed once per place on this grid (the latest sighting there). */
const FIRE_PLACE_GRID_M = 0.5;

/**
 * Water is this aircraft's only extinguishing agent, and it is the wrong one for cooking-oil or grease fires (it
 * spreads burning oil), flammable-liquid fires (it spreads burning fuel) and live electrical fires (it conducts).
 * No observation distinguishes a flame's fuel, so the class comes from the evidence the belief holds
 * (evidence/fire-class.ts: report wording, the prior's room types near the fire, crew statements). Any
 * unresolved water-unsafe indicator for a place the spray reaches refuses it — before approval, before
 * execution and every executing tick, so a report arriving mid-spray stops it. With no indicator, water is
 * allowed and the approval reason discloses that the class is not confirmed (fireClassDisclosure).
 */
function agentRule({ proposal, ctx }: RuleInput): Finding[] {
  const action = proposal.action;
  if (action.kind !== "spray" || ctx.profile.modules.water === null) return [];
  const { assessment, evidenceIds } = sprayFireClass(action, ctx);
  if (assessment.waterSuitable) return [];
  return [finding("H19", `Water is this aircraft's only extinguishing agent and must not be used here. ${assessment.summary}`, evidenceIds)];
}

export interface SprayFireClass {
  readonly assessment: FireClassAssessment;
  /** The fire sightings assessed with the aim point. */
  readonly evidenceIds: readonly ObservationId[];
}

/**
 * The fire-class evidence for everything a spray would reach: its aim point and every place where a fire was
 * seen (within the cited-evidence age, burning or out) inside its discharge sector.
 */
export function sprayFireClass(action: SpraySpec, ctx: HarnessContext): SprayFireClass {
  const water = ctx.profile.modules.water;
  const region = water ? sprayRegion(action, water) : null;
  const freshFrom = ctx.tick - ctx.policy.citedEvidenceMaxAgeTicks;
  const places = new Map<string, { readonly region: Region; readonly observationId: ObservationId; readonly tick: Tick }>();
  for (const h of ctx.belief.hazards) {
    if (region === null || h.hazard !== "fire" || h.tick < freshFrom || !reachesPlace(region, h.region)) continue;
    const c = representativePoint(h.region);
    const key = `${Math.round(c.x / FIRE_PLACE_GRID_M)},${Math.round(c.y / FIRE_PLACE_GRID_M)},${Math.round(c.z / FIRE_PLACE_GRID_M)}`;
    const known = places.get(key);
    if (known === undefined || h.tick >= known.tick) places.set(key, { region: h.region, observationId: h.observationId, tick: h.tick });
  }
  const sightings = [...places.values()];
  return { assessment: assessFireClass(ctx.belief, [sphere(action.aimPoint, AIM_PLACE_RADIUS_M), ...sightings.map(p => p.region)]), evidenceIds: sightings.map(p => p.observationId) };
}

/** A sighting's place reaches into the discharge sector: its centre within its own half-width of it (a cheap test, run every executing tick). */
function reachesPlace(sector: Region, place: Region): boolean {
  const b = regionBounds(place);
  const halfM = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) / 2;
  return distanceToRegion(sector, representativePoint(place)) <= halfM;
}

/** For a spray the harness accepts: the extinguishing-agent disclosure for the commander's approval reason; null for any other action. */
export function fireClassDisclosure(action: ActionSpec, ctx: HarnessContext): string | null {
  if (action.kind !== "spray" || ctx.profile.modules.water === null) return null;
  return `Extinguishing agent (H19): water. ${sprayFireClass(action, ctx).assessment.summary}`;
}

/* Formatting for plain-language reasons. */

function fmt(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : String(value);
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}

function fmtVec(v: Vec3): string {
  return `(${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)})`;
}
