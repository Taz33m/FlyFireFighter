/**
 * Static waypoint graph over a floor-plan prior, built once per prior object and cached by identity.
 *
 * Nodes, each standing in one space (a prior room id or EXTERIOR):
 * - three per opening: an approach point APPROACH_M from the opening centre on each side and the centre
 *   itself, so every route crosses an opening perpendicular to its wall. The two crossing edges are gated
 *   per request by the opening's observed (or planned) state and the traveler;
 * - both ends of every stair, lifted NODE_HEIGHT_M above the tread so the aircraft can fly the same line,
 *   joined by a stair edge;
 * - reflex corners of concave rooms, inset ROOM_CORNER_INSET_M from both walls;
 * - exterior corners: convex room-polygon corners pushed EXTERIOR_CORNER_OFFSET_M outward and kept when at
 *   least EXTERIOR_CLEARANCE_M from every room. They have no planned height; a route interpolates it.
 * Walk edges join nodes of one room when the straight line stays ROOM_CLEARANCE_M inside the room polygon,
 * and exterior nodes when it stays EXTERIOR_CLEARANCE_M outside every room polygon. The prior knows no
 * exterior obstacles beyond the rooms; the reflex controller and harness handle those.
 */
import type { FloorPlanPrior } from "../../contracts/evidence.ts";
import type { Vec3 } from "../../contracts/frames.ts";
import { distance, horizontalDistance, vec3 } from "../../contracts/frames.ts";
import type { Point2 } from "../../contracts/geometry.ts";
import type { RoomId } from "../../contracts/ids.ts";
import { clearInside, clearOutside, cornerOffset, distance2, insidePolygon, pointBoundaryDistance, polygonCorners } from "./plane.ts";

export const EXTERIOR = "exterior";
export const APPROACH_M = 0.6;
export const NODE_HEIGHT_M = 1.0;
export const ROOM_CORNER_INSET_M = 0.45;
export const ROOM_CLEARANCE_M = 0.3;
export const EXTERIOR_CORNER_OFFSET_M = 1.0;
export const EXTERIOR_CLEARANCE_M = 0.6;
const MIN_CORNER_SPACING_M = 0.3;

export type PriorRoom = FloorPlanPrior["rooms"][number];
export type PriorOpening = FloorPlanPrior["openings"][number];

export interface GraphNode {
  readonly id: string;
  /** Room id or EXTERIOR; an opening centre stands in the wall, space "wall:<openingId>". */
  readonly space: string;
  readonly point: Vec3;
  /** Exterior corners have no height of their own; a route interpolates it between its neighbours. */
  readonly floating: boolean;
}

export type EdgeKind = "walk" | "crossing" | "stair";

export interface GraphEdge {
  readonly a: number;
  readonly b: number;
  readonly kind: EdgeKind;
  readonly lengthM: number;
  /** Room id or EXTERIOR the edge runs through; a stair edge carries its stair id. */
  readonly space: string;
  readonly openingId: string | null;
  readonly stairId: string | null;
}

export interface RouteGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Indices of the edges touching each node. */
  readonly adjacency: readonly (readonly number[])[];
}

export interface StaticGraph extends RouteGraph {
  readonly prior: FloorPlanPrior;
  readonly rooms: ReadonlyMap<RoomId, PriorRoom>;
  readonly polygons: readonly (readonly Point2[])[];
  readonly groundZ: number;
  /** Per opening: [approach in rooms[0], centre, approach in rooms[1]] node indices. */
  readonly openingNodes: ReadonlyMap<string, readonly [number, number, number]>;
}

interface Builder {
  readonly prior: FloorPlanPrior;
  readonly rooms: ReadonlyMap<RoomId, PriorRoom>;
  readonly polygons: readonly (readonly Point2[])[];
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
}

const cache = new WeakMap<FloorPlanPrior, StaticGraph>();

export function staticGraph(prior: FloorPlanPrior): StaticGraph {
  const cached = cache.get(prior);
  if (cached) return cached;
  const built = buildGraph(prior);
  cache.set(prior, built);
  return built;
}

export const xy = (p: Vec3): Point2 => [p.x, p.y];

/** Edge length: horizontal when a floating node is involved (its height is not known yet). */
export function nodeDistance(a: GraphNode, b: GraphNode): number {
  return a.floating || b.floating ? horizontalDistance(a.point, b.point) : distance(a.point, b.point);
}

/** Whether a straight walk between two points of a space keeps the required clearance from walls. */
export function walkClear(graph: Pick<StaticGraph, "rooms" | "polygons">, space: string, a: Point2, b: Point2, clearanceM: number): boolean {
  if (space === EXTERIOR) return clearOutside(a, b, graph.polygons, clearanceM);
  const room = graph.rooms.get(space);
  return room !== undefined && clearInside(a, b, room.polygon, clearanceM);
}

export function adjacencyOf(nodeCount: number, edges: readonly GraphEdge[]): number[][] {
  const adjacency: number[][] = Array.from({ length: nodeCount }, () => []);
  edges.forEach((edge, index) => {
    adjacency[edge.a].push(index);
    adjacency[edge.b].push(index);
  });
  return adjacency;
}

function buildGraph(prior: FloorPlanPrior): StaticGraph {
  const rooms = new Map(prior.rooms.map(room => [room.id, room] as const));
  const builder: Builder = { prior, rooms, polygons: prior.rooms.map(room => room.polygon), nodes: [], edges: [] };
  const groundZ = groundElevation(prior);
  const openingNodes = addOpenings(builder);
  addStairs(builder);
  addRoomCorners(builder);
  addExteriorCorners(builder, groundZ);
  addWalkEdges(builder);
  return { prior, rooms, polygons: builder.polygons, groundZ, openingNodes, nodes: builder.nodes, edges: builder.edges, adjacency: adjacencyOf(builder.nodes.length, builder.edges) };
}

function addNode(builder: Builder, node: GraphNode): number {
  builder.nodes.push(node);
  return builder.nodes.length - 1;
}

function addEdge(builder: Builder, a: number, b: number, kind: EdgeKind, space: string, ids: { openingId?: string; stairId?: string } = {}): void {
  const lengthM = nodeDistance(builder.nodes[a], builder.nodes[b]);
  builder.edges.push({ a, b, kind, lengthM, space, openingId: ids.openingId ?? null, stairId: ids.stairId ?? null });
}

function addOpenings(builder: Builder): Map<string, readonly [number, number, number]> {
  const indices = new Map<string, readonly [number, number, number]>();
  for (const opening of builder.prior.openings) {
    const sides = approachPoints(builder, opening);
    if (!sides) continue;
    const [roomA, roomB] = opening.rooms;
    const a = addNode(builder, { id: `opening:${opening.id}:${roomA}`, space: roomA, point: sides[0], floating: false });
    const centre = addNode(builder, { id: `opening:${opening.id}`, space: `wall:${opening.id}`, point: opening.center, floating: false });
    const b = addNode(builder, { id: `opening:${opening.id}:${roomB}`, space: roomB, point: sides[1], floating: false });
    addEdge(builder, a, centre, "crossing", roomA, { openingId: opening.id });
    addEdge(builder, centre, b, "crossing", roomB, { openingId: opening.id });
    indices.set(opening.id, [a, centre, b]);
  }
  return indices;
}

/**
 * Approach points either side of an opening along its horizontal normal, assigned to rooms by containment
 * (a normal drawn the wrong way round is tolerated). Null when the normal has no horizontal component.
 */
function approachPoints(builder: Builder, opening: PriorOpening): readonly [Vec3, Vec3] | null {
  const n = opening.outwardNormal;
  const length = Math.hypot(n.x, n.y);
  if (!(length > 1e-9)) return null;
  const c = opening.center;
  const toward = (sign: number): Vec3 => vec3(c.x + (sign * APPROACH_M * n.x) / length, c.y + (sign * APPROACH_M * n.y) / length, c.z);
  const forward: readonly [Vec3, Vec3] = [toward(-1), toward(1)];
  const roomA = builder.rooms.get(opening.rooms[0]);
  const swapped = roomA !== undefined && !insidePolygon(xy(forward[0]), roomA.polygon) && insidePolygon(xy(forward[1]), roomA.polygon);
  return swapped ? [forward[1], forward[0]] : forward;
}

function addStairs(builder: Builder): void {
  for (const stair of builder.prior.stairs ?? []) {
    const lift = (p: Vec3): Vec3 => vec3(p.x, p.y, p.z + NODE_HEIGHT_M);
    const bottom = addNode(builder, { id: `stair:${stair.id}:bottom`, space: stair.bottomRoomId, point: lift(stair.bottom), floating: false });
    const top = addNode(builder, { id: `stair:${stair.id}:top`, space: stair.topRoomId, point: lift(stair.top), floating: false });
    addEdge(builder, bottom, top, "stair", stair.id, { stairId: stair.id });
  }
}

function addRoomCorners(builder: Builder): void {
  for (const room of builder.prior.rooms) {
    for (const corner of polygonCorners(room.polygon)) {
      if (!corner.reflex) continue;
      const p = cornerOffset(corner, ROOM_CORNER_INSET_M);
      if (!insidePolygon(p, room.polygon) || pointBoundaryDistance(p, room.polygon) < ROOM_CLEARANCE_M) continue;
      addNode(builder, { id: `corner:${room.id}:${corner.index}`, space: room.id, point: vec3(p[0], p[1], room.zMin + NODE_HEIGHT_M), floating: false });
    }
  }
}

function addExteriorCorners(builder: Builder, groundZ: number): void {
  const placed: Point2[] = [];
  for (const room of builder.prior.rooms) {
    for (const corner of polygonCorners(room.polygon)) {
      if (corner.reflex) continue;
      const p = cornerOffset(corner, EXTERIOR_CORNER_OFFSET_M);
      const clear = builder.polygons.every(polygon => !insidePolygon(p, polygon) && pointBoundaryDistance(p, polygon) >= EXTERIOR_CLEARANCE_M);
      if (!clear || placed.some(q => distance2(p, q) < MIN_CORNER_SPACING_M)) continue;
      placed.push(p);
      addNode(builder, { id: `outside:${room.id}:${corner.index}`, space: EXTERIOR, point: vec3(p[0], p[1], groundZ + NODE_HEIGHT_M), floating: true });
    }
  }
}

function addWalkEdges(builder: Builder): void {
  const bySpace = new Map<string, number[]>();
  builder.nodes.forEach((node, index) => {
    if (node.space !== EXTERIOR && !builder.rooms.has(node.space)) return;
    bySpace.set(node.space, [...(bySpace.get(node.space) ?? []), index]);
  });
  for (const [space, indices] of bySpace) {
    const clearance = space === EXTERIOR ? EXTERIOR_CLEARANCE_M : ROOM_CLEARANCE_M;
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        const a = builder.nodes[indices[i]];
        const b = builder.nodes[indices[j]];
        if (walkClear(builder, space, xy(a.point), xy(b.point), clearance)) addEdge(builder, indices[i], indices[j], "walk", space);
      }
    }
  }
}

/** Floor 0's elevation, else the lowest floor or room floor. */
function groundElevation(prior: FloorPlanPrior): number {
  const ground = prior.floors.find(floor => floor.index === 0);
  if (ground) return ground.elevationM;
  const heights = [...prior.floors.map(floor => floor.elevationM), ...prior.rooms.map(room => room.zMin)];
  return heights.length > 0 ? Math.min(...heights) : 0;
}
