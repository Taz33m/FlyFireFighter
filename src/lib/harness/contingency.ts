/**
 * Supported contingencies (PRD §6.4, harness review finding 3).
 *
 * When the mission is aborted, the reserve is reached, localization is lost, a route is blocked, the
 * envelope time box ends or the ambient limit is reached, the harness selects the best maneuver that
 * current evidence supports, in this order:
 *
 *   localized:      return by a usable primary route → usable alternate route → bounded hold → landing → failure
 *   not localized:  landing in place (the supported site under the aircraft, within the pose uncertainty) → failure
 *
 * It never claims a return without a fresh supported route assessment, never assumes a perfect hover or a
 * safe backtrack without localization, and never labels the terminal brake-and-descend behaviour safe.
 * Selection reads only the truth-free belief snapshot; the trigger explains why selection ran, while the
 * current evidence decides what is supported. Every result names its trigger, evidence and termination.
 */
import type { ActionSpec, Contingency, ProposalInput } from "../contracts/actions.ts";
import { SIM_HZ } from "../contracts/clock.ts";
import type { Tick } from "../contracts/clock.ts";
import { envelopeContains } from "../contracts/envelope.ts";
import type { RouteAssessment } from "../contracts/evidence.ts";
import type { ObservationId, RouteId } from "../contracts/ids.ts";
import type { Vec3 } from "../contracts/frames.ts";
import { distanceToRegion } from "../contracts/geometry.ts";
import { localizationSupportsAdvance } from "./motion-guard.ts";
import type { HarnessContext } from "./policy.ts";
import { landInPlaceProblem } from "./rules.ts";

export type ContingencyTrigger = "commander_abort" | "reserve" | "localization_lost" | "route_blocked" | "envelope_expired" | "ambient_limit";

const TRIGGER_TEXT: Readonly<Record<ContingencyTrigger, string>> = {
  commander_abort: "The commander aborted the mission",
  reserve: "Endurance reached the return reserve",
  localization_lost: "Localization stopped supporting movement",
  route_blocked: "The planned route stopped being supported",
  envelope_expired: "The mission envelope time box ended",
  ambient_limit: "Ambient temperature reached the aircraft or envelope limit",
};

/** ProposalInput limits from the boundary schema (schema.ts). */
const MAX_CITED_EVIDENCE = 32;
const MAX_ID_LENGTH = 64;
const MAX_RATIONALE_LENGTH = 600;
const MAX_DURATION_TICKS = 60_000;

type ReturnPurpose = "return" | "alternate_return";

interface RouteChoice {
  readonly route: RouteAssessment | null;
  /** Why each considered route of this purpose is unusable (empty when one is usable). */
  readonly problems: readonly string[];
  /** Evidence of every considered route of this purpose. */
  readonly evidenceIds: readonly ObservationId[];
}

/**
 * Select a contingency. `holdsSpent` counts bounded holds already run without a return becoming usable: a hold
 * exists to wait for a route reassessment, so once one has expired with no usable route the aircraft lands on
 * a supported, safe surface instead of hovering on (a further hold only when no landing is supported).
 */
export function selectContingency(ctx: HarnessContext, trigger: ContingencyTrigger, holdsSpent = 0): Contingency {
  const cause = `${TRIGGER_TEXT[trigger]} (trigger: ${trigger}).`;
  const pose = ctx.belief.pose;
  if (!localizationSupportsAdvance(ctx)) {
    const why = `Localization does not support movement (supported: ${pose.supported}, σ ${fmt(pose.sigmaM)} m, limit ${fmt(ctx.policy.maxSigmaForAdvanceM)} m), so no return, route or perfect hover is assumed`;
    return landOrFail(ctx, cause, why, [], true);
  }
  const primary = chooseRoute(ctx, "return");
  if (primary.route) return routeContingency("return", primary.route, ctx, `${cause} Return by route ${primary.route.id}: ${routeSupport(primary.route, ctx)}.`);
  const alternate = chooseRoute(ctx, "alternate_return");
  const routeEvidence = [...primary.evidenceIds, ...alternate.evidenceIds];
  if (alternate.route) {
    const reason = `${cause} No primary return route is usable (${joinProblems(primary.problems)}). Alternate route ${alternate.route.id}: ${routeSupport(alternate.route, ctx)}.`;
    return routeContingency("alternate_route", alternate.route, ctx, reason);
  }
  const noRoute = `no return route is usable (${joinProblems([...primary.problems, ...alternate.problems])})`;
  const hold = holdBound(ctx);
  if (holdsSpent > 0 && landingAvailable(ctx)) {
    return landOrFail(ctx, cause, `${capitalize(noRoute)} after ${holdsSpent} bounded hold${holdsSpent === 1 ? "" : "s"} waiting for one`, routeEvidence, false);
  }
  if (hold.maxTicks > 0) {
    return {
      kind: "hold",
      maxTicks: hold.maxTicks,
      reason: `${cause} ${capitalize(noRoute)}; ${hold.support}.`,
      evidenceIds: boundedIds(routeEvidence),
      termination: `Hold at most ${hold.maxTicks} ticks (${fmt(hold.maxTicks / SIM_HZ)} s): until a route is reassessed as supported, the reserve limit or the ambient limit, whichever comes first; then select again.`,
    };
  }
  return landOrFail(ctx, cause, `${capitalize(noRoute)} and a bounded hold is not supported (${hold.support})`, routeEvidence, false);
}

/** The proposal the harness submits for a selected contingency; null for an explicit failure. */
export function contingencyProposalInput(contingency: Contingency, ctx: HarnessContext): ProposalInput | null {
  const action = contingencyAction(contingency);
  if (action === null) return null;
  return {
    runId: ctx.belief.runId,
    aircraftId: ctx.profile.id,
    proposer: "contingency",
    action,
    rationale: (contingency.reason.trim() || `Contingency ${contingency.kind}.`).slice(0, MAX_RATIONALE_LENGTH),
    citedEvidence: boundedIds(contingency.evidenceIds),
    basis: {
      evidenceRevision: ctx.belief.evidenceRevision,
      mapRevision: ctx.belief.mapRevision,
      profileRevision: ctx.profile.revision,
      envelopeRevision: ctx.envelope.revision,
      policyRevision: ctx.policy.revision,
    },
    createdTick: ctx.tick,
    expiresTick: ctx.tick + ctx.policy.maxProposalLifetimeTicks,
  };
}

/**
 * Whether the return reserve requires returning now. marginS is the endurance left before that point:
 * enduranceRemainingS − (shortest usable return or alternate route) − returnReserveS; mustReturn when it is
 * ≤ 0. With no usable route marginS is null and mustReturn is true: a contingency must be selected.
 */
export function reserveStatus(ctx: HarnessContext): { mustReturn: boolean; marginS: number | null; reason: string } {
  const remainingS = ctx.belief.aircraft.enduranceRemainingS;
  const reserveS = ctx.profile.hardLimits.returnReserveS;
  const primary = chooseRoute(ctx, "return");
  const alternate = chooseRoute(ctx, "alternate_return");
  const candidates = [primary.route, alternate.route].filter((route): route is RouteAssessment => route !== null);
  const shortest = candidates.sort(byPreference)[0];
  if (shortest === undefined) {
    return { mustReturn: true, marginS: null, reason: `No usable return route (${joinProblems([...primary.problems, ...alternate.problems])}); a contingency is required.` };
  }
  const marginS = remainingS - shortest.estimatedDurationS - reserveS;
  const budget = `${fmt(remainingS)} s endurance remaining, ${fmt(shortest.estimatedDurationS)} s by route ${shortest.id}, ${fmt(reserveS)} s reserve`;
  return marginS <= 0
    ? { mustReturn: true, marginS, reason: `Return required: ${budget}.` }
    : { mustReturn: false, marginS, reason: `${fmt(marginS)} s before return is required: ${budget}.` };
}

/* Routes. */

/**
 * The preferred usable route of one purpose. Only the latest assessment of each route id counts, so an
 * older "supported" assessment can never outlive a newer "unsupported" one.
 */
function chooseRoute(ctx: HarnessContext, purpose: ReturnPurpose): RouteChoice {
  const routes = latestAssessments(ctx.belief.routes).filter(route => route.purpose === purpose);
  const evidenceIds = routes.flatMap(route => route.evidenceIds);
  const usable = routes.filter(route => routeProblem(route, ctx) === null).sort(byPreference);
  if (usable.length > 0) return { route: usable[0], problems: [], evidenceIds };
  const label = purpose === "return" ? "primary return" : "alternate return";
  const problems = routes.length === 0 ? [`no ${label} route assessed`] : routes.map(route => routeProblem(route, ctx) ?? "");
  return { route: null, problems, evidenceIds };
}

function latestAssessments(routes: readonly RouteAssessment[]): RouteAssessment[] {
  const latest = new Map<RouteId, RouteAssessment>();
  for (const route of routes) {
    const known = latest.get(route.id);
    if (known === undefined || route.assessedTick >= known.assessedTick) latest.set(route.id, route);
  }
  return [...latest.values()];
}

/** Why a route cannot carry a contingency now, or null when it is usable. */
function routeProblem(route: RouteAssessment, ctx: HarnessContext): string | null {
  const ageTicks = ctx.tick - route.assessedTick;
  const remainingS = ctx.belief.aircraft.enduranceRemainingS;
  if (route.status !== "supported") return `route ${route.id} is ${route.status}: ${route.reason}`;
  if (!(ageTicks <= ctx.policy.returnRouteFreshTicks)) return `route ${route.id} was assessed ${ageTicks} ticks ago, beyond the ${ctx.policy.returnRouteFreshTicks}-tick limit`;
  if (route.waypoints.length === 0) return `route ${route.id} has no waypoints`;
  const outside = route.waypoints.findIndex(point => !envelopeContains(ctx.envelope, point, ctx.belief.pose.sigmaM));
  if (outside >= 0) return `route ${route.id} waypoint ${outside} lies outside envelope revision ${ctx.envelope.revision}`;
  if (!(route.estimatedDurationS >= 0 && route.estimatedDurationS <= remainingS)) {
    return `route ${route.id} needs an estimated ${fmt(route.estimatedDurationS)} s but only ${fmt(remainingS)} s of endurance remain`;
  }
  return null;
}

/** Shortest estimated duration first, then the freshest assessment, then route id. */
function byPreference(a: RouteAssessment, b: RouteAssessment): number {
  return a.estimatedDurationS - b.estimatedDurationS || b.assessedTick - a.assessedTick || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function routeSupport(route: RouteAssessment, ctx: HarnessContext): string {
  return `assessed supported at tick ${route.assessedTick} (${ctx.tick - route.assessedTick} ticks ago), estimated ${fmt(route.estimatedDurationS)} s against ${fmt(ctx.belief.aircraft.enduranceRemainingS)} s endurance remaining`;
}

function routeContingency(kind: "return" | "alternate_route", route: RouteAssessment, ctx: HarnessContext, reason: string): Contingency {
  const termination = `Ends on arrival at the final waypoint of route ${route.id}; select again if the route stops being supported, its assessment ages past ${ctx.policy.returnRouteFreshTicks} ticks, localization is lost or endurance falls below the route's estimate.`;
  return { kind, routeId: route.id, reason, evidenceIds: boundedIds(route.evidenceIds), termination };
}

/* Hold, landing and failure. */

/** A bounded hold needs a known ambient within limits and endurance above the return reserve. */
function holdBound(ctx: HarnessContext): { maxTicks: Tick; support: string } {
  const ambientC = ctx.belief.aircraft.ambientC;
  const limitC = Math.min(ctx.profile.hardLimits.maxAmbientC, ctx.envelope.ambientCeilingC);
  if (ambientC === null || !(ambientC <= limitC)) {
    return { maxTicks: 0, support: `ambient ${ambientC === null ? "unknown" : `${fmt(ambientC)} °C`} is not within the ${fmt(limitC)} °C limit` };
  }
  const spareS = ctx.belief.aircraft.enduranceRemainingS - ctx.profile.hardLimits.returnReserveS;
  // Rounded down so the hold can never eat into the reserve; NaN endurance gives no hold.
  const spareTicks = spareS > 0 ? Math.floor(spareS * SIM_HZ) : 0;
  const maxTicks = Math.max(0, Math.floor(Math.min(ctx.policy.maxHoldTicks, spareTicks, MAX_DURATION_TICKS)));
  if (maxTicks <= 0) return { maxTicks: 0, support: `endurance ${fmt(ctx.belief.aircraft.enduranceRemainingS)} s leaves nothing above the ${fmt(ctx.profile.hardLimits.returnReserveS)} s reserve` };
  return { maxTicks, support: `supported localization, ambient ${fmt(ambientC)} °C within the ${fmt(limitC)} °C limit and ${fmt(spareS)} s of endurance above the reserve support a hold of at most ${maxTicks} ticks` };
}

/** Whether a supported landing site exists that a contingency could use (not beside a fire). */
function landingAvailable(ctx: HarnessContext): boolean {
  const landing = ctx.belief.landing;
  return landing.supported && landing.site !== null && landingNearFire(landing.site, ctx) === null;
}

/** A contingency never lands this close to a fire seen within the cited-evidence age: that is not a safe landing. */
export const LANDING_FIRE_CLEARANCE_M = 1.5;

/** Why landing at `site` is unsafe because of fire evidence, or null. */
function landingNearFire(site: Vec3, ctx: HarnessContext): string | null {
  const freshFrom = ctx.tick - ctx.policy.citedEvidenceMaxAgeTicks;
  const fire = ctx.belief.hazards.find(h => h.hazard === "fire" && h.intensity > 0 && h.tick >= freshFrom && distanceToRegion(h.region, site) < LANDING_FIRE_CLEARANCE_M);
  return fire ? `the landing site is ${fmt(distanceToRegion(fire.region, site))} m from the fire seen in observation ${fire.observationId}, within the ${fmt(LANDING_FIRE_CLEARANCE_M)} m clearance` : null;
}

function landOrFail(ctx: HarnessContext, cause: string, why: string, routeEvidence: readonly ObservationId[], inPlace: boolean): Contingency {
  const landing = ctx.belief.landing;
  // Without localization the aircraft can only descend where it is: the site must be under it.
  const underProblem = inPlace && landing.supported && landing.site !== null ? landInPlaceProblem(landing.site, ctx) : null;
  const notUnder = underProblem ?? (landing.supported && landing.site !== null ? landingNearFire(landing.site, ctx) : null);
  if (landing.supported && landing.site !== null && notUnder === null) {
    return {
      kind: "land",
      site: landing.site,
      reason: `${cause} ${why}; ${inPlace ? "landing in place" : "landing"} is supported: ${landing.reason}`,
      evidenceIds: boundedIds(landing.evidenceIds),
      termination: `Ends at touchdown on the supported surface at (${fmt(landing.site.x)}, ${fmt(landing.site.y)}, ${fmt(landing.site.z)}); if landing support is lost first, select again.`,
    };
  }
  const descent = Math.min(ctx.policy.terminalDescentMps, ctx.profile.hardLimits.maxVerticalSpeedMps);
  const noLanding = notUnder !== null
    ? `${underProblem !== null ? "landing in place is not possible" : "landing is not safe"}: ${notUnder}`
    : landing.supported ? "landing is reported supported but names no site" : `landing is not supported: ${landing.reason}`;
  return {
    kind: "failure",
    terminalBehavior: "brake_and_descend",
    reason: `${cause} ${why}; ${noLanding}. No supported maneuver remains.`,
    evidenceIds: boundedIds([...routeEvidence, ...landing.evidenceIds]),
    termination: `Mission failure recorded. Brake and descend at ${fmt(descent)} m/s until ground contact; this is an unsupported terminal behaviour, not a safe landing.`,
  };
}

/* Proposal action. */

function contingencyAction(contingency: Contingency): ActionSpec | null {
  switch (contingency.kind) {
    case "return":
    case "alternate_route":
      return { kind: "return", routeId: contingency.routeId };
    case "hold":
      return { kind: "hold", durationTicks: contingency.maxTicks };
    case "land":
      return { kind: "land", site: contingency.site };
    case "failure":
      return null;
  }
}

/* Helpers. */

/** Distinct ids that fit the proposal schema, at most MAX_CITED_EVIDENCE. */
function boundedIds(ids: readonly ObservationId[]): ObservationId[] {
  const valid = ids.filter(id => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH);
  return [...new Set(valid)].slice(0, MAX_CITED_EVIDENCE);
}

function joinProblems(problems: readonly string[]): string {
  return problems.filter(problem => problem.length > 0).join("; ");
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function fmt(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : String(value);
}
