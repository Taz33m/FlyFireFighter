/**
 * Static walking graph for occupants (truth-side; a small visibility graph, not a navigation mesh).
 *
 * Nodes, each in exactly one room (or EXTERIOR):
 * - door approach points APPROACH_M either side of every walkable opening's threshold (doors and doorways
 *   with a horizontal passage, a low sill and at least MIN_PASSAGE_WIDTH_M; never windows). For a listed exit
 *   the outside node is the door-front goal, DOOR_FRONT_OFFSET_M beyond the threshold. Crossing an opening is
 *   always perpendicular through its threshold;
 * - both ends of every stair (the stair path itself may pass through slab bands that belong to no room);
 * - reflex corners of concave rooms, inset CORNER_CLEARANCE_M from both walls, so L-shaped rooms are walkable.
 * Edges: crossings (gated by the opening's state at query time), stairs, and walks between nodes of the same
 * room whose knee-height line clears every static wall. Built once per scene metadata and cached; the static
 * walls come from that metadata's own colliders, never from a world's collider list, which experiments extend
 * with per-run obstructions that must not leak into other runs sharing the metadata.
 */
import type { Vec3 } from "../contracts/frames.ts";
import { add, distance, scale, vec3 } from "../contracts/frames.ts";
import { pointInPolygon } from "../contracts/geometry.ts";
import { fromJsonVec3 } from "../contracts/scene.ts";
import { roomUnderFeet } from "./feet.ts";
import { lineOfSight } from "./raycast.ts";
import { EXTERIOR, openingThreshold } from "./scene.ts";
import type { RuntimeCollider, RuntimeRoom, SceneModel } from "./world-state.ts";

export const APPROACH_M = 0.4;
export const DOOR_FRONT_OFFSET_M = 1.0;
export const MIN_PASSAGE_WIDTH_M = 0.5;
export const CORNER_CLEARANCE_M = 0.4;
export const KNEE_HEIGHT_M = 0.4;
const MAX_SILL_M = 0.25;
/** Colliders that stop a walking occupant at knee height (furniture is stepped around; floors and stairs are walked on). */
export const OCCUPANT_BLOCKING_KINDS: ReadonlySet<RuntimeCollider["kind"]> = new Set(["wall", "door", "glass"]);

export interface RouteNode {
  readonly point: Vec3;
  readonly room: string;
  readonly goal: boolean;
}

export interface RouteEdge {
  readonly to: number;
  readonly lengthM: number;
  /** The opening crossed by this edge, whose state gates it; null for walks and stairs. */
  readonly openingId: string | null;
}

export interface RouteGraph {
  readonly nodes: readonly RouteNode[];
  readonly edges: readonly (readonly RouteEdge[])[];
  readonly stairs: readonly { readonly bottom: number; readonly top: number }[];
}

const cache = new WeakMap<object, RouteGraph>();

export const lift = (p: Vec3, h: number): Vec3 => vec3(p.x, p.y, p.z + h);

interface Draft {
  readonly nodes: RouteNode[];
  /** Crossing and stair edges, linked before the same-room walks. */
  readonly special: [number, number, string | null][];
}

function addNode(draft: Draft, point: Vec3, room: string, goal = false): number {
  return draft.nodes.push({ point, room, goal }) - 1;
}

/** Approach nodes either side of each walkable opening (the door-front goal outside a listed exit). */
function addOpenings(draft: Draft, scene: SceneModel): void {
  const exits = new Set(scene.meta.exits.map(e => e.openingId));
  for (const o of scene.openings) {
    const walkable = o.kind !== "window" && Math.abs(o.outwardNormal.z) < 0.5 && o.sillHeightM <= MAX_SILL_M && o.widthM >= MIN_PASSAGE_WIDTH_M;
    const outside = o.rooms[1] === EXTERIOR;
    if (!walkable || (outside && !exits.has(o.id))) continue;
    const threshold = openingThreshold(o);
    const a = addNode(draft, add(threshold, scale(o.outwardNormal, -APPROACH_M)), o.rooms[0]);
    const b = addNode(draft, add(threshold, scale(o.outwardNormal, outside ? DOOR_FRONT_OFFSET_M : APPROACH_M)), o.rooms[1], outside);
    draft.special.push([a, b, o.id]);
  }
}

function addStairs(draft: Draft, scene: SceneModel): RouteGraph["stairs"] {
  return scene.meta.stairs.map(s => {
    const bottom = fromJsonVec3(s.bottom);
    const top = fromJsonVec3(s.top);
    const b = addNode(draft, bottom, roomUnderFeet(scene.rooms, bottom)?.id ?? "");
    const t = addNode(draft, top, roomUnderFeet(scene.rooms, top)?.id ?? "");
    draft.special.push([b, t, null]);
    return { bottom: b, top: t };
  });
}

/** The scene's authored walls (no opening leaf, no per-run obstruction), from the metadata the graph is cached on. */
function staticWalls(scene: SceneModel): RuntimeCollider[] {
  return scene.meta.colliders
    .filter(c => (c.openingId ?? null) === null && OCCUPANT_BLOCKING_KINDS.has(c.kind))
    .map(c => ({ id: c.id, kind: c.kind, min: fromJsonVec3(c.min), max: fromJsonVec3(c.max), openingId: null }));
}

/** Crossings, stairs and same-room walks whose knee-height line clears every static wall. */
function linkEdges(draft: Draft, scene: SceneModel): RouteEdge[][] {
  const { nodes } = draft;
  const edges: RouteEdge[][] = nodes.map(() => []);
  const walls = staticWalls(scene);
  const link = (i: number, j: number, openingId: string | null): void => {
    if (!lineOfSight(walls, lift(nodes[i].point, KNEE_HEIGHT_M), lift(nodes[j].point, KNEE_HEIGHT_M))) return;
    const lengthM = distance(nodes[i].point, nodes[j].point);
    edges[i].push({ to: j, lengthM, openingId });
    edges[j].push({ to: i, lengthM, openingId });
  };
  for (const [i, j, openingId] of draft.special) link(i, j, openingId);
  for (let i = 0; i < nodes.length; i++) {
    const room = nodes[i].room;
    if (room === "" || room === EXTERIOR) continue;
    for (let j = i + 1; j < nodes.length; j++) if (nodes[j].room === room) link(i, j, null);
  }
  return edges;
}

export function routeGraph(scene: SceneModel): RouteGraph {
  const cached = cache.get(scene.meta);
  if (cached) return cached;
  const draft: Draft = { nodes: [], special: [] };
  addOpenings(draft, scene);
  const stairs = addStairs(draft, scene);
  for (const room of scene.rooms) for (const corner of insetReflexCorners(room)) addNode(draft, corner, room.id);
  const graph: RouteGraph = { nodes: draft.nodes, edges: linkEdges(draft, scene), stairs };
  cache.set(scene.meta, graph);
  return graph;
}

/** Reflex (concave) corners of a counter-clockwise room polygon, moved into the room clear of both walls. */
function insetReflexCorners(room: RuntimeRoom): Vec3[] {
  const poly = room.polygon;
  const corners: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[(i + poly.length - 1) % poly.length];
    const v = poly[i];
    const n = poly[(i + 1) % poly.length];
    const e1 = unit2(v[0] - p[0], v[1] - p[1]);
    const e2 = unit2(n[0] - v[0], n[1] - v[1]);
    if (e1[0] * e2[1] - e1[1] * e2[0] >= -1e-9) continue;
    // Inward (left) normals of both walls; their sum keeps the point clear of each wall.
    const x = v[0] + (-e1[1] - e2[1]) * CORNER_CLEARANCE_M;
    const y = v[1] + (e1[0] + e2[0]) * CORNER_CLEARANCE_M;
    if (pointInPolygon(x, y, poly)) corners.push(vec3(x, y, room.zMin));
  }
  return corners;
}

function unit2(x: number, y: number): [number, number] {
  const n = Math.hypot(x, y);
  return n > 0 ? [x / n, y / n] : [0, 0];
}
