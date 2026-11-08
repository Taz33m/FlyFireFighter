/**
 * Route assessment flow. Route the request over the prior's waypoint graph using only openings the traveler
 * can pass. If fire evidence newer than the last intervention overlaps that path's corridor, look for a
 * detour whose every leg avoids it; with none, the route is unsupported and keeps the blocked path's
 * waypoints so planners can relate the fire to it. Otherwise judge support from fresh evidence (support.ts).
 * An exit destination must be reached from the inside and crossed outward before the `then` point.
 */
import type { HazardEvidence, RouteAssessment } from "../../contracts/evidence.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { isFiniteVec3, vec3 } from "../../contracts/frames.ts";
import { representativePoint } from "../../contracts/geometry.ts";
import type { ObservationId } from "../../contracts/ids.ts";
import { deepFreeze } from "../../contracts/ids.ts";
import { corridorOf, legPrism, overlapsCorridor } from "./corridor.ts";
import type { GraphEdge, RouteGraph, StaticGraph } from "./graph.ts";
import { EXTERIOR, staticGraph } from "./graph.ts";
import type { RouteAssessorInput, RouteRequest } from "./index.ts";
import type { Endpoint, PathResult, PlannedPath } from "./search.ts";
import { assemble, locate, shortestPath, withEndpoints } from "./search.ts";
import type { SupportContext, Traveler } from "./support.ts";
import { ageLimitS, corridorViews, describeOpening, ROUTE_MIN_FRESH_SEARCHED_FRACTION, fireSupport, openingState, openingSupport, passableFor, roomSupport, supportContext } from "./support.ts";

const MAX_EVIDENCE_IDS = 32;
const MAX_REASON_CHARS = 1000;
const MAX_LISTED = 6;

type EdgeFilter = (edge: GraphEdge, index: number) => boolean;

interface Routing {
  readonly graph: RouteGraph;
  readonly start: number;
  readonly goal: number | null;
  /** Exit destination: the opening centre, its outside approach and the outward crossing edge. */
  readonly exit: { readonly centre: number; readonly outside: number; readonly crossing: number } | null;
  /** The start already stands on the exit's outer side. */
  readonly startOutside: boolean;
  readonly label: string;
}

export function assess(input: RouteAssessorInput, request: RouteRequest): RouteAssessment {
  checkRequest(request);
  const base = staticGraph(input.belief.mapPrior);
  const ctx = supportContext(input.belief, input.tick, input.lastInterventionTick, input.policy, base);
  const routing = route(base, request, input.policy.wallClearanceM);
  if (typeof routing === "string") return finish(input, request, null, "unsupported", routing, []);
  const passable = passabilityFilter(ctx, request.traveler);
  const parts = findPath(routing, passable);
  if (!parts) return noPath(input, request, ctx, routing, passable);
  const path = assemble(routing.graph, base, parts);
  const blocking = ctx.blockingFires.filter(h => overlapsCorridor(h.region, corridorOf(path.legs, base))).sort((a, b) => b.tick - a.tick);
  if (blocking.length === 0) return judge(input, request, ctx, path);
  const fireFree = fireFilter(ctx, routing.graph);
  const detour = findPath(routing, (edge, index) => passable(edge, index) && fireFree(edge, index));
  if (detour) return judge(input, request, ctx, assemble(routing.graph, base, detour));
  return finish(input, request, path, "unsupported", fireReason(ctx, request.traveler, blocking), blocking.map(h => h.observationId));
}

function checkRequest(request: RouteRequest): void {
  if (!isFiniteVec3(request.from)) throw new RangeError(`Route ${request.id}: the start must be finite.`);
  if (!(request.speedMps > 0 && Number.isFinite(request.speedMps))) throw new RangeError(`Route ${request.id}: speed must be positive and finite, got ${request.speedMps}.`);
  const d = request.destination;
  const target = d.kind === "point" ? d.point : d.then;
  if (target !== null && !isFiniteVec3(target)) throw new RangeError(`Route ${request.id}: the destination must be finite.`);
}

function route(base: StaticGraph, request: RouteRequest, wallClearanceM: number): Routing | string {
  const d = request.destination;
  const goalPoint = d.kind === "point" ? d.point : d.then;
  const endpoints: Endpoint[] = [{ id: "start", point: request.from, located: locate(base, request.from, wallClearanceM) }];
  if (goalPoint) endpoints.push({ id: "goal", point: goalPoint, located: locate(base, goalPoint, wallClearanceM) });
  const graph = withEndpoints(base, endpoints);
  const start = base.nodes.length;
  const goal = goalPoint ? start + 1 : null;
  if (d.kind === "point") return { graph, start, goal, exit: null, startOutside: false, label: `the point ${fmtVec(d.point)}` };
  const exit = base.prior.exits.find(e => e.id === d.exitId);
  const nodes = exit ? base.openingNodes.get(exit.openingId) : undefined;
  if (!exit || !nodes) return `Exit ${d.exitId} does not lead through an opening of the floor-plan prior, so no route to it can be assessed.`;
  const [, centre, outside] = nodes;
  const crossing = graph.adjacency[outside].find(e => graph.edges[e].a === centre || graph.edges[e].b === centre) ?? -1;
  const startOutside = endpoints[0].located.space === base.nodes[outside].space;
  const label = `exit ${d.exitId} (${exit.openingId})${goalPoint ? ` and then ${fmtVec(goalPoint)}` : ""}`;
  return { graph, start, goal, exit: { centre, outside, crossing }, startOutside, label };
}

function findPath(r: Routing, allowed: EdgeFilter): PathResult[] | null {
  if (!r.exit) return r.goal === null ? null : single(shortestPath(r.graph, r.start, r.goal, allowed));
  const { centre, outside, crossing } = r.exit;
  if (r.startOutside) return single(shortestPath(r.graph, r.start, r.goal ?? outside, allowed));
  if (crossing < 0 || !allowed(r.graph.edges[crossing], crossing)) return null;
  const inside = shortestPath(r.graph, r.start, centre, (edge, index) => index !== crossing && allowed(edge, index));
  if (!inside) return null;
  const beyond = r.goal === null ? { nodes: [outside], edges: [] } : shortestPath(r.graph, outside, r.goal, allowed);
  return beyond ? [inside, { nodes: [centre, outside], edges: [crossing] }, beyond] : null;
}

function single(path: PathResult | null): PathResult[] | null {
  return path ? [path] : null;
}

function passabilityFilter(ctx: SupportContext, traveler: Traveler): EdgeFilter {
  const verdicts = new Map(ctx.graph.prior.openings.map(o => [o.id, passableFor(traveler, o, openingState(ctx, o))] as const));
  return edge => edge.kind !== "crossing" || (edge.openingId !== null && verdicts.get(edge.openingId) === true);
}

/** Edges whose own corridor touches blocking fire evidence; computed lazily per edge. */
function fireFilter(ctx: SupportContext, graph: RouteGraph): EdgeFilter {
  const verdicts = new Map<number, boolean>();
  return (edge, index) => {
    const known = verdicts.get(index);
    if (known !== undefined) return known;
    const corridor = [legPrism({ a: graph.nodes[edge.a].point, b: graph.nodes[edge.b].point, kind: edge.kind, space: edge.space }, ctx.graph)];
    const clear = !ctx.blockingFires.some(h => overlapsCorridor(h.region, corridor));
    verdicts.set(index, clear);
    return clear;
  };
}

function noPath(input: RouteAssessorInput, request: RouteRequest, ctx: SupportContext, r: Routing, passable: EdgeFilter): RouteAssessment {
  const reached = flood(r.graph, r.start, passable);
  const ids = new Set<string>();
  r.graph.edges.forEach((edge, index) => {
    if (edge.openingId !== null && !passable(edge, index) && (reached.has(edge.a) || reached.has(edge.b))) ids.add(edge.openingId);
  });
  const openings = ctx.graph.prior.openings.filter(o => ids.has(o.id) && (request.traveler === "drone" || o.kind !== "window"));
  const why = openings.length > 0 ? `impassable openings: ${list(openings.map(o => describeOpening(ctx, o)))}` : "the plan does not connect them";
  const evidenceIds = openings.flatMap(o => {
    const seen = ctx.openings.get(o.id);
    return seen ? [seen.observationId] : [];
  });
  return finish(input, request, null, "unsupported", `No passable path for the ${request.traveler} from ${fmtVec(request.from)} to ${r.label}: ${why}.`, evidenceIds);
}

function flood(graph: RouteGraph, start: number, allowed: EdgeFilter): Set<number> {
  const reached = new Set<number>([start]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const e of graph.adjacency[queue[i]]) {
      const edge = graph.edges[e];
      const next = edge.a === queue[i] ? edge.b : edge.a;
      if (reached.has(next) || !allowed(edge, e)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return reached;
}

function judge(input: RouteAssessorInput, request: RouteRequest, ctx: SupportContext, path: PlannedPath): RouteAssessment {
  const corridor = corridorOf(path.legs, ctx.graph);
  // The drone's own passage needs passable openings and no fire on its corridor. Whether the rooms it crosses
  // are empty of people is not its route's question: the harness keeps it clear of walls and of possible
  // occupants every tick. Rooms on an occupant's route must be person-searched.
  const rooms = request.traveler === "drone" ? { problems: [], evidenceIds: [] } : roomSupport(ctx, path.roomIds);
  const openings = openingSupport(ctx, path.openingIds);
  const fire = fireSupport(ctx, corridor);
  const found = [...openings.evidenceIds, ...rooms.evidenceIds, ...fire.evidenceIds];
  const evidenceIds = found.length > 0 ? found : corridorViews(ctx, corridor);
  const problems = [
    ...section("rooms without fresh coverage", rooms.problems),
    ...section("openings without a fresh observation", openings.problems),
    ...fire.problems,
    ...(evidenceIds.length === 0 ? ["no fresh observation in the evidence window covers the route"] : []),
  ];
  if (problems.length > 0) return finish(input, request, path, "unknown", `Not yet supported for the ${request.traveler}: ${problems.join("; ")}.`, evidenceIds);
  return finish(input, request, path, "supported", supportedReason(ctx, request, path, fire.evidenceIds.length > 0), evidenceIds);
}

function section(title: string, items: readonly string[]): string[] {
  return items.length > 0 ? [`${title}: ${list(items)}`] : [];
}

function supportedReason(ctx: SupportContext, request: RouteRequest, path: PlannedPath, fireRechecked: boolean): string {
  const when = ctx.lastInterventionTick === null ? `within the last ${ageLimitS(ctx)} s` : `after the intervention at tick ${ctx.lastInterventionTick}`;
  const parts = [
    `${fmt(path.lengthM)} m for the ${request.traveler}, about ${fmt(path.lengthM / request.speedMps)} s`,
    path.roomIds.length === 0
      ? "no rooms on the route; fresh views of it"
      : request.traveler === "drone"
        ? `rooms on the route (${list(path.roomIds)}) need no person search for the drone's own passage; the harness guards its clearance`
        : `rooms person-searched (at least ${Math.round(ROUTE_MIN_FRESH_SEARCHED_FRACTION * 100)}% each) ${when}: ${list(path.roomIds)}`,
    ...(path.openingIds.length > 0 ? [`openings observed: ${list(path.openingIds.map(id => `${id} ${ctx.openings.get(id)?.state ?? "unknown"}`))}`] : []),
    ...(fireRechecked ? ["fire seen earlier beside the route was re-observed with no fire"] : []),
  ];
  return `Supported: ${parts.join("; ")}.`;
}

function fireReason(ctx: SupportContext, traveler: Traveler, blocking: readonly HazardEvidence[]): string {
  const since = ctx.lastInterventionTick === null ? "" : ` after the intervention at tick ${ctx.lastInterventionTick}`;
  const sightings = blocking.slice(0, 3).map(h => `tick ${h.tick} (${h.observationId}, ${placeOf(ctx, h)})`);
  return `Fire observed${since} overlaps the walking corridor for the ${traveler} and no passable detour avoids it: ${sightings.join("; ")}.`;
}

function placeOf(ctx: SupportContext, hazard: HazardEvidence): string {
  const located = locate(ctx.graph, representativePoint(hazard.region), ctx.policy.wallClearanceM);
  return located.space === EXTERIOR ? "outside" : `in ${located.space}`;
}

function finish(input: RouteAssessorInput, request: RouteRequest, path: PlannedPath | null, status: RouteAssessment["status"], reason: string, evidenceIds: readonly ObservationId[]): RouteAssessment {
  return deepFreeze({
    id: request.id,
    purpose: request.purpose,
    waypoints: path ? path.waypoints.map(p => vec3(p.x, p.y, p.z)) : [],
    status,
    assessedTick: input.tick,
    evidenceIds: [...new Set(evidenceIds)].slice(0, MAX_EVIDENCE_IDS),
    estimatedDurationS: path ? path.lengthM / request.speedMps : 0,
    reason: reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS - 1)}…` : reason,
  });
}

function list(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(", ");
  return items.length > MAX_LISTED ? `${shown} and ${items.length - MAX_LISTED} more` : shown;
}

function fmt(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

function fmtVec(v: Vec3): string {
  return `(${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)})`;
}
