/**
 * Request-time routing: locate the start and destination in the prior, attach them to the static graph and
 * find the shortest permitted path. Ties within TIE_EPS_M go to the lexically smallest node-id sequence, so
 * the result never depends on iteration order.
 */
import type { Vec3 } from "../../contracts/frames.ts";
import { vec3 } from "../../contracts/frames.ts";
import type { Point2 } from "../../contracts/geometry.ts";
import type { RoomId } from "../../contracts/ids.ts";
import type { EdgeKind, GraphEdge, GraphNode, PriorRoom, RouteGraph, StaticGraph } from "./graph.ts";
import { adjacencyOf, EXTERIOR, EXTERIOR_CLEARANCE_M, nodeDistance, ROOM_CLEARANCE_M, walkClear, xy } from "./graph.ts";
import { direction2, distance2, insidePolygon, nearestBoundaryPoint, pointBoundaryDistance } from "./plane.ts";

const TIE_EPS_M = 1e-6;
const NUDGE_M = 0.05;
/** An endpoint near a wall may walk away from it, but no closer than this share of its own clearance. */
const ENDPOINT_CLEARANCE_SHARE = 0.9;
const MIN_ENDPOINT_CLEARANCE_M = 0.01;

export interface Located {
  readonly space: string;
  /** The point used for visibility: inside its room even when the request point lies in the wall band. */
  readonly anchor: Point2;
  readonly clearanceM: number;
}

export interface Endpoint {
  readonly id: string;
  readonly point: Vec3;
  readonly located: Located;
}

export interface Leg {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly kind: EdgeKind;
  readonly space: string;
  readonly openingId: string | null;
  readonly stairId: string | null;
}

export interface PlannedPath {
  readonly waypoints: readonly Vec3[];
  readonly legs: readonly Leg[];
  readonly lengthM: number;
  /** Openings crossed, in order. */
  readonly openingIds: readonly string[];
  /** Rooms the route walks through (stair rooms included), in order of first appearance. */
  readonly roomIds: readonly RoomId[];
}

/**
 * The room containing the point (nearest height band when several floors share the footprint), else a room
 * within wallClearanceM horizontally (the point is in its wall band; the anchor is nudged inside), else the
 * exterior.
 */
export function locate(graph: StaticGraph, p: Vec3, wallClearanceM: number): Located {
  const at: Point2 = [p.x, p.y];
  const containing = graph.prior.rooms.filter(room => insidePolygon(at, room.polygon));
  if (containing.length > 0) {
    const room = nearestRoom(containing, p, at);
    return { space: room.id, anchor: at, clearanceM: pointBoundaryDistance(at, room.polygon) };
  }
  const near = graph.prior.rooms.filter(room => pointBoundaryDistance(at, room.polygon) <= wallClearanceM);
  if (near.length > 0) {
    const room = nearestRoom(near, p, at);
    const anchor = nudgeInside(at, room.polygon);
    return { space: room.id, anchor, clearanceM: pointBoundaryDistance(anchor, room.polygon) };
  }
  const clearanceM = graph.polygons.reduce((best, polygon) => Math.min(best, pointBoundaryDistance(at, polygon)), Infinity);
  return { space: EXTERIOR, anchor: at, clearanceM };
}

function bandDistance(room: PriorRoom, z: number): number {
  return Math.max(room.zMin - z, 0, z - room.zMax);
}

function nearestRoom(rooms: readonly PriorRoom[], p: Vec3, at: Point2): PriorRoom {
  const scored = rooms.map(room => ({ room, band: bandDistance(room, p.z), wall: insidePolygon(at, room.polygon) ? 0 : pointBoundaryDistance(at, room.polygon) }));
  scored.sort((a, b) => a.band - b.band || a.wall - b.wall || (a.room.id < b.room.id ? -1 : a.room.id > b.room.id ? 1 : 0));
  return scored[0].room;
}

function nudgeInside(at: Point2, polygon: readonly Point2[]): Point2 {
  const edge = nearestBoundaryPoint(at, polygon);
  const inward = direction2(at, edge);
  const candidate: Point2 = inward ? [edge[0] + inward[0] * NUDGE_M, edge[1] + inward[1] * NUDGE_M] : edge;
  return insidePolygon(candidate, polygon) ? candidate : edge;
}

/** The static graph plus endpoint nodes, each joined to the visible nodes of its space (and to each other). */
export function withEndpoints(graph: StaticGraph, endpoints: readonly Endpoint[]): RouteGraph {
  const nodes: GraphNode[] = [...graph.nodes];
  const edges: GraphEdge[] = [...graph.edges];
  const anchors: Point2[] = graph.nodes.map(node => xy(node.point));
  const required: number[] = graph.nodes.map(node => spaceClearance(node.space));
  for (const endpoint of endpoints) {
    const index = nodes.length;
    const space = endpoint.located.space;
    nodes.push({ id: endpoint.id, space, point: endpoint.point, floating: false });
    anchors.push(endpoint.located.anchor);
    required.push(Math.max(MIN_ENDPOINT_CLEARANCE_M, Math.min(spaceClearance(space), ENDPOINT_CLEARANCE_SHARE * endpoint.located.clearanceM)));
    for (let other = 0; other < index; other++) {
      if (nodes[other].space !== space || !walkClear(graph, space, anchors[index], anchors[other], Math.min(required[index], required[other]))) continue;
      edges.push({ a: other, b: index, kind: "walk", lengthM: nodeDistance(nodes[other], nodes[index]), space, openingId: null, stairId: null });
    }
  }
  return { nodes, edges, adjacency: adjacencyOf(nodes.length, edges) };
}

function spaceClearance(space: string): number {
  return space === EXTERIOR ? EXTERIOR_CLEARANCE_M : ROOM_CLEARANCE_M;
}

export interface PathResult {
  readonly nodes: readonly number[];
  readonly edges: readonly number[];
}

/** Dijkstra over at most a few hundred nodes; null when the target cannot be reached through allowed edges. */
export function shortestPath(graph: RouteGraph, source: number, target: number, allowed: (edge: GraphEdge, index: number) => boolean): PathResult | null {
  const count = graph.nodes.length;
  const dist = new Float64Array(count).fill(Infinity);
  const key: string[] = new Array<string>(count).fill("");
  const via = new Int32Array(count).fill(-1);
  const done = new Uint8Array(count);
  dist[source] = 0;
  key[source] = graph.nodes[source].id;
  for (let u = source; u >= 0 && u !== target; u = nextNode(dist, key, done)) {
    done[u] = 1;
    for (const e of graph.adjacency[u]) {
      const edge = graph.edges[e];
      const v = edge.a === u ? edge.b : edge.a;
      if (done[v] || !allowed(edge, e)) continue;
      const d = dist[u] + edge.lengthM;
      const k = `${key[u]}>${graph.nodes[v].id}`;
      if (d < dist[v] - TIE_EPS_M || (Math.abs(d - dist[v]) <= TIE_EPS_M && k < key[v])) {
        dist[v] = d;
        key[v] = k;
        via[v] = e;
      }
    }
  }
  return Number.isFinite(dist[target]) ? unwind(graph, source, target, via) : null;
}

function nextNode(dist: Float64Array, key: readonly string[], done: Uint8Array): number {
  let best = -1;
  for (let i = 0; i < dist.length; i++) {
    if (done[i] || !Number.isFinite(dist[i])) continue;
    if (best < 0 || dist[i] < dist[best] - TIE_EPS_M || (Math.abs(dist[i] - dist[best]) <= TIE_EPS_M && key[i] < key[best])) best = i;
  }
  return best;
}

function unwind(graph: RouteGraph, source: number, target: number, via: Int32Array): PathResult {
  const nodes = [target];
  const edges: number[] = [];
  for (let v = target; v !== source; ) {
    const edge = graph.edges[via[v]];
    edges.unshift(via[v]);
    v = edge.a === v ? edge.b : edge.a;
    nodes.unshift(v);
  }
  return { nodes, edges };
}

/** Waypoints and legs of node/edge sequences laid end to end; floating heights are interpolated. */
export function assemble(graph: RouteGraph, base: StaticGraph, parts: readonly PathResult[]): PlannedPath {
  const nodeSeq = parts.flatMap((part, i) => (i === 0 ? part.nodes : part.nodes.slice(1)));
  const edgeSeq = parts.flatMap(part => part.edges);
  const points = resolveHeights(nodeSeq.map(i => graph.nodes[i]));
  const legs: Leg[] = edgeSeq.map((e, i) => {
    const edge = graph.edges[e];
    return { a: points[i], b: points[i + 1], kind: edge.kind, space: edge.space, openingId: edge.openingId, stairId: edge.stairId };
  });
  const lengthM = legs.reduce((sum, leg) => sum + Math.hypot(leg.b.x - leg.a.x, leg.b.y - leg.a.y, leg.b.z - leg.a.z), 0);
  return { waypoints: dedupe(points), legs, lengthM, openingIds: unique(legs.flatMap(leg => (leg.openingId ? [leg.openingId] : []))), roomIds: roomsOf(legs, base) };
}

function resolveHeights(nodes: readonly GraphNode[]): Vec3[] {
  const along: number[] = [0];
  for (let i = 1; i < nodes.length; i++) along.push(along[i - 1] + distance2(xy(nodes[i - 1].point), xy(nodes[i].point)));
  return nodes.map((node, i) => {
    if (!node.floating) return node.point;
    const z = interpolatedZ(nodes, along, i) ?? node.point.z;
    return vec3(node.point.x, node.point.y, z);
  });
}

/** Height of a floating node, linear in horizontal distance between its nearest fixed neighbours. */
function interpolatedZ(nodes: readonly GraphNode[], along: readonly number[], i: number): number | null {
  const before = lastFixed(nodes, i, -1);
  const after = lastFixed(nodes, i, 1);
  if (before < 0 || after < 0) return before < 0 && after < 0 ? null : nodes[Math.max(before, after)].point.z;
  const span = along[after] - along[before];
  const t = span > 0 ? (along[i] - along[before]) / span : 0;
  return nodes[before].point.z + t * (nodes[after].point.z - nodes[before].point.z);
}

function lastFixed(nodes: readonly GraphNode[], from: number, step: number): number {
  for (let i = from + step; i >= 0 && i < nodes.length; i += step) if (!nodes[i].floating) return i;
  return -1;
}

function dedupe(points: readonly Vec3[]): Vec3[] {
  return points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y, p.z - points[i - 1].z) > 1e-9);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function roomsOf(legs: readonly Leg[], base: StaticGraph): RoomId[] {
  const stairs = new Map((base.prior.stairs ?? []).map(stair => [stair.id, [stair.bottomRoomId, stair.topRoomId]] as const));
  const ids = legs.flatMap(leg => (leg.stairId ? [...(stairs.get(leg.stairId) ?? [])] : [leg.space]));
  return unique(ids.filter(id => base.rooms.has(id)));
}
