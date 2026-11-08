/**
 * Route-support evidence from the truth-free belief snapshot: opening states, fire evidence split by the
 * last intervention, fresh room coverage and fresh looks at earlier fire locations.
 *
 * - An opening's state is its latest observation, else the plan's state. Drones pass open or broken
 *   openings; occupants pass open, broken or closed doors and doorways (people open unlocked doors) but
 *   never windows. Nobody passes a blocked or unknown opening. Routing uses the latest state of any age;
 *   support needs each crossed opening observed after the last intervention and within
 *   policy.routeEvidenceMaxAgeTicks (60 s by default, the same limit H15 applies).
 * - Each room on the route needs at least ROUTE_MIN_FRESH_SEARCHED_FRACTION of its sample points covered
 *   by adequate-quality person-search frames captured after the last intervention and within
 *   policy.routeEvidenceMaxAgeTicks (the room's freshness profile, RoomCoverage.searchedSince). A frame
 *   glimpsing a corner, a frame with no person search or a low-quality frame does not count; the sticky
 *   run-wide coverage state is not used.
 * - Supersession links count only when valid (evidence/supersession.ts: same sensor and frame, not captured
 *   later); a superseded frame's fire evidence is replaced by its replacement's, and an invalid link hides
 *   nothing.
 * - Fire evidence captured after the last intervention and within policy.routeEvidenceMaxAgeTicks blocks a
 *   route. Any other fire evidence beside the route needs a later look (after the evidence and after the
 *   intervention, within policy.routeEvidenceMaxAgeTicks) by a person search or a visual frame of adequate
 *   quality that shows no fire there, at the points where the evidence meets the route's corridor (raised
 *   VIEW_HEIGHT_M above the floor). Suppression alone never clears it; no new sighting is not a look.
 * - Fire evidence is reduced to the latest sighting per place first (per-frame sightings differ slightly).
 * - A fire sighting of intensity 0 is a camera's report that it saw the place where a fire burned and no flame
 *   there (sensors report it only where a flame would have been visible). It never blocks a route. A flame
 *   sighting with a later intensity-0 sighting at the same place (overlapping regions) no longer blocks: it is
 *   earlier fire beside the route, and the route still needs the clearing look above (after the intervention,
 *   within the age limit, adequate quality); an observation reporting no flame at a corridor point is such a
 *   look there. A flame detection counts against a look only with intensity above 0.
 */
import type { Tick } from "../../contracts/clock.ts";
import { secondsFromTicks, ticksFromSeconds } from "../../contracts/clock.ts";
import type { BeliefSnapshot, HazardEvidence, OpeningEvidence, RoomCoverage } from "../../contracts/evidence.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { vec3 } from "../../contracts/frames.ts";
import type { Bounds, Region } from "../../contracts/geometry.ts";
import { boundsIntersect, distanceToRegion, prism, regionBounds, regionContains } from "../../contracts/geometry.ts";
import type { ObservationId, OpeningId, RoomId } from "../../contracts/ids.ts";
import { searchedFractionSince } from "../../evidence/coverage.ts";
import { supersessions } from "../../evidence/supersession.ts";
import type { Observation, OpeningState } from "../../contracts/observation.ts";
import type { HarnessPolicy } from "../../harness/policy.ts";
import { CORRIDOR_HALF_WIDTH_M, corridorPointsIn, overlapsCorridor } from "./corridor.ts";
import type { PriorOpening, StaticGraph } from "./graph.ts";
import { insidePolygon } from "./plane.ts";

/**
 * Default age limit for route evidence. The assessor uses the harness policy's routeEvidenceMaxAgeTicks
 * (this value under DEFAULT_POLICY), so a route it supports always passes the harness's guidance rule H15,
 * which requires every cited id to be within that age and still in the belief's observation window.
 */
export const ROUTE_EVIDENCE_MAX_AGE_TICKS: Tick = ticksFromSeconds(60);
/** Minimum fraction of each route room adequately person-searched after the intervention, within the age limit. */
export const ROUTE_MIN_FRESH_SEARCHED_FRACTION = 0.3;
const MAX_VIEWS_PER_ROOM = 2;

/** The route evidence age limit in seconds, for plain-language reasons. */
export function ageLimitS(ctx: { readonly policy: HarnessPolicy }): number {
  return secondsFromTicks(ctx.policy.routeEvidenceMaxAgeTicks);
}
const PLACE_GRID_M = 0.25;
const VIEW_HEIGHT_M = 0.3;

export type Traveler = "drone" | "occupant";

export interface SupportContext {
  readonly belief: BeliefSnapshot;
  readonly tick: Tick;
  readonly lastInterventionTick: Tick | null;
  readonly policy: HarnessPolicy;
  readonly graph: StaticGraph;
  /** Observations no other observation in the belief supersedes, newest capture first (then id). */
  readonly observations: readonly Observation[];
  readonly openings: ReadonlyMap<OpeningId, OpeningEvidence>;
  readonly blockingFires: readonly HazardEvidence[];
  readonly earlierFires: readonly HazardEvidence[];
}

export interface Check {
  readonly problems: readonly string[];
  readonly evidenceIds: readonly ObservationId[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function supportContext(belief: BeliefSnapshot, tick: Tick, lastInterventionTick: Tick | null, policy: HarnessPolicy, graph: StaticGraph): SupportContext {
  const superseded = new Set(supersessions(belief.observations).keys());
  const observations = belief.observations.filter(o => !superseded.has(o.id)).sort((a, b) => b.captureTick - a.captureTick || compareText(a.id, b.id));
  const sightings = belief.hazards.filter(h => h.hazard === "fire" && !superseded.has(h.observationId));
  const fires = latestPerPlace(sightings.filter(isFlame));
  const outs = sightings.filter(h => !isFlame(h));
  const seenOut = (h: HazardEvidence): boolean => outs.some(out => isLater(out, h) && boundsIntersect(regionBounds(out.region), regionBounds(h.region)));
  const blocks = (h: HazardEvidence): boolean => h.tick >= tick - policy.routeEvidenceMaxAgeTicks && (lastInterventionTick === null || h.tick > lastInterventionTick) && !seenOut(h);
  return {
    belief, tick, lastInterventionTick, policy, graph, observations,
    openings: latestOpenings(belief.openings),
    blockingFires: fires.filter(blocks),
    earlierFires: fires.filter(h => !blocks(h)),
  };
}

/** A fire sighting showing flame (intensity above 0); intensity 0 reports the place seen with no flame. */
function isFlame(h: { readonly intensity: number }): boolean {
  return h.intensity > 0;
}

function isLater(a: HazardEvidence, b: HazardEvidence): boolean {
  return a.tick > b.tick || (a.tick === b.tick && a.observationId > b.observationId);
}

/**
 * The latest fire evidence per place (region bounds on a PLACE_GRID_M grid). Sensors report every frame's
 * sighting with slightly different bounds, so the belief can hold thousands; a newer sighting of the same
 * place decides both whether it blocks and how recent a clearing look must be.
 */
function latestPerPlace(fires: readonly HazardEvidence[]): HazardEvidence[] {
  const latest = new Map<string, HazardEvidence>();
  for (const h of fires) {
    const b = regionBounds(h.region);
    const key = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map(v => Math.round(v / PLACE_GRID_M)).join(",");
    const current = latest.get(key);
    if (!current || h.tick > current.tick || (h.tick === current.tick && h.observationId > current.observationId)) latest.set(key, h);
  }
  return [...latest.values()];
}

function latestOpenings(evidence: readonly OpeningEvidence[]): Map<OpeningId, OpeningEvidence> {
  const latest = new Map<OpeningId, OpeningEvidence>();
  for (const e of evidence) {
    const current = latest.get(e.openingId);
    if (!current || e.tick > current.tick || (e.tick === current.tick && e.observationId > current.observationId)) latest.set(e.openingId, e);
  }
  return latest;
}

export function openingState(ctx: SupportContext, opening: PriorOpening): OpeningState | "unknown" {
  return ctx.openings.get(opening.id)?.state ?? opening.priorState;
}

export function passableFor(traveler: Traveler, opening: PriorOpening, state: OpeningState | "unknown"): boolean {
  if (state === "open" || state === "broken") return traveler === "drone" || opening.kind !== "window";
  return traveler === "occupant" && state === "closed" && opening.kind !== "window";
}

export function describeOpening(ctx: SupportContext, opening: PriorOpening): string {
  const seen = ctx.openings.get(opening.id);
  return seen ? `${opening.id} ${seen.state} (observed at tick ${seen.tick})` : `${opening.id} ${opening.priorState} (plan; not observed)`;
}

/** Oldest capture tick that counts as fresh: after the intervention and within the age limit. */
export function freshSince(ctx: SupportContext): Tick {
  return Math.max(ctx.tick - ctx.policy.routeEvidenceMaxAgeTicks, (ctx.lastInterventionTick ?? -1) + 1);
}

/** Every crossed opening needs a fresh observed state: the plan is not current geometry and old states change. */
export function openingSupport(ctx: SupportContext, openingIds: readonly OpeningId[]): Check {
  const problems: string[] = [];
  const evidenceIds: ObservationId[] = [];
  for (const id of openingIds) {
    const seen = ctx.openings.get(id);
    if (!seen) problems.push(`${id} (plan says ${ctx.graph.prior.openings.find(o => o.id === id)?.priorState ?? "unknown"}; not observed)`);
    // A broken pane cannot become intact again: its latest observation stays valid for passability however old
    // (a newer "blocked" observation would replace it as the latest state). It is cited while still fresh.
    else if (seen.state === "broken") {
      if (seen.tick >= ctx.tick - ctx.policy.routeEvidenceMaxAgeTicks && (ctx.lastInterventionTick === null || seen.tick > ctx.lastInterventionTick)) evidenceIds.push(seen.observationId);
    }
    else if (ctx.lastInterventionTick !== null && seen.tick <= ctx.lastInterventionTick) problems.push(`${id} (last observed ${seen.state} at tick ${seen.tick}, before the intervention at tick ${ctx.lastInterventionTick})`);
    else if (seen.tick < ctx.tick - ctx.policy.routeEvidenceMaxAgeTicks) problems.push(`${id} (last observed ${seen.state} at tick ${seen.tick}, more than ${ageLimitS(ctx)} s ago)`);
    else evidenceIds.push(seen.observationId);
  }
  return { problems, evidenceIds };
}

/**
 * Each room on the route needs ROUTE_MIN_FRESH_SEARCHED_FRACTION of it adequately person-searched after the
 * intervention and within the age limit, and fresh person-search views of it to cite.
 */
export function roomSupport(ctx: SupportContext, roomIds: readonly RoomId[]): Check {
  const problems: string[] = [];
  const evidenceIds: ObservationId[] = [];
  const since = freshSince(ctx);
  for (const roomId of roomIds) {
    const coverage = ctx.belief.coverage.find(c => c.roomId === roomId);
    const views = roomViews(ctx, roomId, since);
    const problem = roomProblem(ctx, roomId, coverage, since, views.length);
    if (problem) problems.push(problem);
    else evidenceIds.push(...views);
  }
  return { problems, evidenceIds };
}

function roomProblem(ctx: SupportContext, roomId: RoomId, coverage: RoomCoverage | undefined, since: Tick, views: number): string | null {
  const last = coverage?.lastObservedTick ?? null;
  if (!coverage || coverage.state === "unobserved" || last === null) return `${roomId} (never observed)`;
  const fresh = searchedFractionSince(coverage, since);
  if (fresh >= ROUTE_MIN_FRESH_SEARCHED_FRACTION && views > 0) return null;
  if (ctx.lastInterventionTick !== null && last <= ctx.lastInterventionTick) return `${roomId} (last observed at tick ${last}, before the intervention at tick ${ctx.lastInterventionTick})`;
  if (last < ctx.tick - ctx.policy.routeEvidenceMaxAgeTicks) return `${roomId} (last observed at tick ${last}, more than ${ageLimitS(ctx)} s ago)`;
  if (coverage.state === "degraded") return `${roomId} (only degraded coverage, last at tick ${last})`;
  const window = ctx.lastInterventionTick === null ? `in the last ${ageLimitS(ctx)} s` : `since the intervention at tick ${ctx.lastInterventionTick}`;
  if (fresh >= ROUTE_MIN_FRESH_SEARCHED_FRACTION) return `${roomId} (no person-search view of it ${window} remains in the evidence window)`;
  return `${roomId} (only ${pct(fresh)} person-searched at adequate quality ${window}; needs ${pct(ROUTE_MIN_FRESH_SEARCHED_FRACTION)})`;
}

/** Fresh adequate-quality person-search views of the room (newest first, bounded) to cite. */
function roomViews(ctx: SupportContext, roomId: RoomId, since: Tick): ObservationId[] {
  const room = ctx.graph.rooms.get(roomId);
  if (!room) return [];
  const roomBounds = regionBounds(prism(room.polygon, room.zMin, room.zMax));
  const views: ObservationId[] = [];
  for (const o of ctx.observations) {
    if (o.captureTick < since || views.length >= MAX_VIEWS_PER_ROOM) break;
    if (o.footprint !== null && o.personSearch !== null && o.quality >= ctx.policy.minCoverageQuality && boundsIntersect(footprintBounds(o), roomBounds)) views.push(o.id);
  }
  return views;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Fresh views of the corridor (for routes that cross no room, such as an exterior return). */
export function corridorViews(ctx: SupportContext, corridor: readonly Region[]): ObservationId[] {
  const oldest = Math.max(ctx.tick - ctx.policy.routeEvidenceMaxAgeTicks, (ctx.lastInterventionTick ?? -1) + 1);
  const parts = corridor.map(regionBounds);
  const views = ctx.observations.filter(o => o.captureTick >= oldest && o.footprint !== null && o.quality >= ctx.policy.minCoverageQuality && parts.some(b => boundsIntersect(footprintBounds(o), b)));
  return views.slice(0, MAX_VIEWS_PER_ROOM).map(o => o.id);
}

interface Target {
  readonly point: Vec3;
  /** A clearing look must be captured after this tick. */
  readonly after: Tick;
  readonly hazard: HazardEvidence;
}

/** Earlier fire beside the route must have been re-observed, showing no fire, after the evidence and the intervention. */
export function fireSupport(ctx: SupportContext, corridor: readonly Region[]): Check {
  const targets = clearingTargets(ctx, ctx.earlierFires.filter(h => overlapsCorridor(h.region, corridor)), corridor);
  if (targets.length === 0) return { problems: [], evidenceIds: [] };
  const used = new Set<ObservationId>();
  const missed: Target[] = [];
  for (const target of targets) {
    const view = clearingView(ctx, target);
    if (view) used.add(view.id);
    else missed.push(target);
  }
  const enough = targets.length - missed.length >= ctx.policy.minCoverageFraction * targets.length;
  return { problems: enough ? [] : [fireProblem(ctx, missed, targets.length)], evidenceIds: [...used] };
}

function clearingTargets(ctx: SupportContext, fires: readonly HazardEvidence[], corridor: readonly Region[]): Target[] {
  const byKey = new Map<string, Target>();
  for (const hazard of fires) {
    const after = Math.max(hazard.tick, ctx.lastInterventionTick ?? hazard.tick);
    for (const sample of corridorPointsIn(hazard.region, corridor)) {
      const point = viewTarget(ctx.graph, sample);
      if (!point) continue;
      const key = `${Math.round(point.x * 10)},${Math.round(point.y * 10)},${Math.round(point.z * 10)}`;
      const current = byKey.get(key);
      if (!current || after > current.after) byKey.set(key, { point, after, hazard });
    }
  }
  return [...byKey.values()];
}

/**
 * A camera sees the air above a spot, not the floor surface (its footprint stops at the floor), so a target
 * is raised to VIEW_HEIGHT_M above the floor under it. Points inside the building outline but in no room's
 * height band lie in a slab and cannot be viewed; they are skipped.
 */
function viewTarget(graph: StaticGraph, p: Vec3): Vec3 | null {
  const over = graph.prior.rooms.filter(room => insidePolygon([p.x, p.y], room.polygon));
  const room = over.find(r => p.z >= r.zMin && p.z <= r.zMax);
  if (!room && over.length > 0) return null;
  const floor = room ? room.zMin : graph.groundZ;
  const z = Math.max(p.z, floor + VIEW_HEIGHT_M);
  return room && z > room.zMax ? null : vec3(p.x, p.y, z);
}

function clearingView(ctx: SupportContext, target: Target): Observation | null {
  const oldest = Math.max(target.after + 1, ctx.tick - ctx.policy.routeEvidenceMaxAgeTicks);
  for (const o of ctx.observations) {
    if (o.captureTick < oldest) return null;
    if (showsNoFireAt(ctx, o, target.point)) return o;
  }
  return null;
}

/** An adequate look at p with no flame near it: p in the footprint, or a no-flame report (intensity 0) at p. */
function showsNoFireAt(ctx: SupportContext, o: Observation, p: Vec3): boolean {
  if (o.footprint === null || o.quality < ctx.policy.minCoverageQuality) return false;
  if (o.personSearch === null && o.modality !== "rgb" && o.modality !== "thermal") return false;
  const near = (d: Observation["detections"][number]) => d.kind === "hazard" && d.hazard === "fire" && distanceToRegion(d.region, p) <= CORRIDOR_HALF_WIDTH_M;
  if (o.detections.some(d => near(d) && d.kind === "hazard" && isFlame(d))) return false;
  if (o.detections.some(d => near(d) && d.kind === "hazard" && !isFlame(d))) return true;
  const b = footprintBounds(o);
  if (p.x < b.min.x || p.y < b.min.y || p.z < b.min.z || p.x > b.max.x || p.y > b.max.y || p.z > b.max.z) return false;
  return regionContains(o.footprint, p);
}

function fireProblem(ctx: SupportContext, missed: readonly Target[], total: number): string {
  const sightings = [...new Map(missed.map(t => [t.hazard.observationId, t.hazard] as const)).values()].sort((a, b) => b.tick - a.tick).slice(0, 3);
  const since = ctx.lastInterventionTick === null ? "" : ` after the intervention at tick ${ctx.lastInterventionTick}`;
  return `fire seen beside the route (${sightings.map(h => `tick ${h.tick}, ${h.observationId}`).join("; ")}) needs a fresh look${since}: ${missed.length} of ${total} points not re-observed`;
}

const boundsCache = new WeakMap<Observation, Bounds>();

function footprintBounds(o: Observation): Bounds {
  let bounds = boundsCache.get(o);
  if (!bounds && o.footprint) {
    bounds = regionBounds(o.footprint);
    boundsCache.set(o, bounds);
  }
  return bounds ?? { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
}
