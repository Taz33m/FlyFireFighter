/**
 * Occupant evacuation routes: shortest paths over the static walking graph (occupant-graph.ts), checked
 * against current truth on every query, so a route is a pure function of the world at that tick.
 *
 * An edge is passable when no active fire blocks it near the floor or at waist height (fireBlocks), it does
 * not bring the walker inside a burning fire's radiant standoff (point-source flux χr·Q/(4πR²) above the
 * ISO 13571 tenability limit of 2.5 kW/m²; moving away is allowed), no dynamic blocker crosses it at knee
 * height (intact glass, the leaf of a blocked door, an experiment obstruction; static walls were checked
 * when the graph was built), and smoke along it stays at or below OCCUPANT_SMOKE_TOLERANCE_PER_M at
 * crouch height. Crossing an opening is allowed unless the opening is
 * "blocked": a closed door is passable because the occupant opens it on arrival (the aircraft cannot).
 */
import type { Vec3 } from "../contracts/frames.ts";
import { distance, horizontalDistance, vec3 } from "../contracts/frames.ts";
import { distanceToRegion, prism, representativePoint } from "../contracts/geometry.ts";
import { extinctionAt, fireBlocks } from "./fire.ts";
import type { RouteGraph } from "./occupant-graph.ts";
import { FEET_BAND_M, roomUnderFeet } from "./feet.ts";
import { KNEE_HEIGHT_M, lift, OCCUPANT_BLOCKING_KINDS, routeGraph } from "./occupant-graph.ts";
import { lineOfSight } from "./raycast.ts";
import type { RuntimeCollider, SceneModel, WorldState } from "./world-state.ts";
import { activeColliders } from "./world-state.ts";

export { DOOR_FRONT_OFFSET_M } from "./occupant-graph.ts";
export const OCCUPANT_SMOKE_TOLERANCE_PER_M = 3.0;
/** Radiant fraction χr of heat release for the point-source flux model. */
export const RADIANT_FRACTION = 0.3;
/** ISO 13571 radiant-heat tenability limit; occupants do not approach a fire closer than this flux. */
export const TENABLE_RADIANT_FLUX_KW_M2 = 2.5;
/** Fires more than this far above or below both ends of a segment are on another level. */
const SAME_LEVEL_M = 2.5;
/** Colliders added by experiments carry this id prefix and always block occupants. */
export const OBSTRUCTION_ID_PREFIX = "obstruction:";
const FIRE_CHECK_HEIGHTS_M = [0.1, 1.0];
const SMOKE_HEIGHT_M = 1.0;
const SMOKE_SAMPLE_SPACING_M = 1.0;
/** A point this close to a room (e.g. standing in its doorway) counts as in it. */
const DOORWAY_REACH_M = 0.35;

export type OccupantPlace = { readonly kind: "room"; readonly roomId: string } | { readonly kind: "stair"; readonly index: number } | { readonly kind: "exterior" };

export interface EvacuationRoute {
  /** Waypoints after the start, ending at a door-front point outside an exit. */
  readonly waypoints: readonly Vec3[];
  /** The opening crossed on the way to each waypoint, or null, so the occupant can open closed doors. */
  readonly crossings: readonly (string | null)[];
  readonly lengthM: number;
}

/** Where a person's feet are: in a room (including its doorways), on a stair (which may pass through slabs in no room), or outside. */
export function locateFeet(scene: SceneModel, p: Vec3): OccupantPlace {
  const room = roomUnderFeet(scene.rooms, p);
  if (room) return { kind: "room", roomId: room.id };
  const stairIndex = scene.meta.stairs.findIndex(s => onStair(s, p));
  if (stairIndex >= 0) return { kind: "stair", index: stairIndex };
  let best: { id: string; d: number } | null = null;
  for (const r of scene.rooms) {
    if (p.z < r.zMin - 0.1 || p.z > r.zMin + FEET_BAND_M) continue;
    const d = distanceToRegion(prism(r.polygon, r.zMin - 0.1, r.zMin + FEET_BAND_M), p);
    if (d <= DOORWAY_REACH_M && (best === null || d < best.d)) best = { id: r.id, d };
  }
  return best ? { kind: "room", roomId: best.id } : { kind: "exterior" };
}

function onStair(s: SceneModel["meta"]["stairs"][number], p: Vec3): boolean {
  const bottom = vec3(s.bottom[0], s.bottom[1], s.bottom[2]);
  const top = vec3(s.top[0], s.top[1], s.top[2]);
  if (p.z < bottom.z - 0.1 || p.z > top.z + 0.1) return false;
  const run = horizontalDistance(bottom, top);
  const along = run > 0 ? ((p.x - bottom.x) * (top.x - bottom.x) + (p.y - bottom.y) * (top.y - bottom.y)) / (run * run) : 0;
  if (along < -0.05 || along > 1.05) return false;
  const t = Math.max(0, Math.min(1, along));
  const onLine = vec3(bottom.x + (top.x - bottom.x) * t, bottom.y + (top.y - bottom.y) * t, bottom.z + (top.z - bottom.z) * t);
  return horizontalDistance(p, onLine) <= s.widthM / 2 + 0.1 && Math.abs(p.z - onLine.z) <= 0.4;
}

function openable(world: WorldState, openingId: string | null): boolean {
  return openingId !== null && world.openings.find(o => o.id === openingId)?.state === "closed";
}

/**
 * Colliders that stop a walking occupant now. `dynamicOnly` leaves out static walls (already checked in the
 * graph). Leaves of closed, openable doors never block: the occupant opens them.
 */
export function occupantBlockers(world: WorldState, dynamicOnly = false): RuntimeCollider[] {
  return activeColliders(world).filter(c => {
    if (c.id.startsWith(OBSTRUCTION_ID_PREFIX)) return true;
    if (!OCCUPANT_BLOCKING_KINDS.has(c.kind) || (dynamicOnly && c.openingId === null)) return false;
    return !(c.kind === "door" && openable(world, c.openingId));
  });
}

/** Distance within which a fire's point-source radiant flux χr·Q/(4πR²) exceeds the tenability limit. */
export function radiantStandoffM(heatReleaseKW: number): number {
  return Math.sqrt(Math.max(0, RADIANT_FRACTION * heatReleaseKW) / (4 * Math.PI * TENABLE_RADIANT_FLUX_KW_M2));
}

function horizontalSegmentDistance(a: Vec3, b: Vec3, c: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(a.x + t * dx - c.x, a.y + t * dy - c.y);
}

/** True when a→b brings the walker closer to a burning fire than its radiant standoff (moving away is allowed). */
function tooHot(world: WorldState, a: Vec3, b: Vec3): boolean {
  return world.fires.some(fire => {
    if (fire.extinguished || !(fire.heatReleaseKW > 0)) return false;
    const c = fire.region.kind === "sphere" ? fire.region.center : representativePoint(fire.region);
    if (Math.min(Math.abs(c.z - a.z), Math.abs(c.z - b.z)) > SAME_LEVEL_M) return false;
    const closest = horizontalSegmentDistance(a, b, c);
    return closest < radiantStandoffM(fire.heatReleaseKW) && closest < horizontalDistance(a, c) - 1e-6;
  });
}

/** Whether an occupant can walk the straight segment a→b (feet points) right now. */
export function segmentPassable(world: WorldState, blockers: readonly RuntimeCollider[], a: Vec3, b: Vec3): boolean {
  if (FIRE_CHECK_HEIGHTS_M.some(h => fireBlocks(world, lift(a, h), lift(b, h))) || tooHot(world, a, b)) return false;
  if (blockers.length > 0 && !lineOfSight(blockers, lift(a, KNEE_HEIGHT_M), lift(b, KNEE_HEIGHT_M))) return false;
  const samples = Math.max(1, Math.ceil(distance(a, b) / SMOKE_SAMPLE_SPACING_M));
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t + SMOKE_HEIGHT_M);
    if (extinctionAt(world, p) > OCCUPANT_SMOKE_TOLERANCE_PER_M) return false;
  }
  return true;
}

interface Search {
  readonly world: WorldState;
  readonly graph: RouteGraph;
  readonly dynamicBlockers: readonly RuntimeCollider[];
  readonly dist: number[];
  readonly prev: number[];
  readonly via: (string | null)[];
  readonly done: boolean[];
}

function startNodes(graph: RouteGraph, place: Exclude<OccupantPlace, { kind: "exterior" }>): number[] {
  if (place.kind === "stair") return [graph.stairs[place.index].bottom, graph.stairs[place.index].top];
  return graph.nodes.flatMap((node, i) => (node.room === place.roomId ? [i] : []));
}

function nearestOpen(search: Search): number {
  let u = -1;
  for (let i = 0; i < search.dist.length; i++) {
    if (!search.done[i] && search.dist[i] < Infinity && (u < 0 || search.dist[i] < search.dist[u])) u = i;
  }
  return u;
}

function relax(search: Search, u: number): void {
  const { world, graph, dist, prev, via, done } = search;
  for (const edge of graph.edges[u]) {
    const v = edge.to;
    const candidate = dist[u] + edge.lengthM;
    if (done[v] || candidate >= dist[v]) continue;
    if (edge.openingId !== null && world.openings.find(o => o.id === edge.openingId)?.state === "blocked") continue;
    if (!segmentPassable(world, search.dynamicBlockers, graph.nodes[u].point, graph.nodes[v].point)) continue;
    dist[v] = candidate;
    prev[v] = u;
    via[v] = edge.openingId;
  }
}

/** Shortest passable route from the feet point to any door-front, or null when none exists or `from` is outside. */
export function planEvacuationRoute(world: WorldState, from: Vec3): EvacuationRoute | null {
  const graph = routeGraph(world.scene);
  const place = locateFeet(world.scene, from);
  if (place.kind === "exterior") return null;
  const n = graph.nodes.length;
  const search: Search = {
    world, graph, dynamicBlockers: occupantBlockers(world, true),
    dist: new Array<number>(n).fill(Infinity), prev: new Array<number>(n).fill(-1), via: new Array<string | null>(n).fill(null), done: new Array<boolean>(n).fill(false),
  };
  const allBlockers = occupantBlockers(world);
  for (const i of startNodes(graph, place)) {
    if (segmentPassable(world, allBlockers, from, graph.nodes[i].point)) search.dist[i] = distance(from, graph.nodes[i].point);
  }
  for (let u = nearestOpen(search); u >= 0; u = nearestOpen(search)) {
    if (graph.nodes[u].goal) return reconstruct(search, u);
    search.done[u] = true;
    relax(search, u);
  }
  return null;
}

function reconstruct(search: Search, goal: number): EvacuationRoute {
  const waypoints: Vec3[] = [];
  const crossings: (string | null)[] = [];
  for (let i = goal; i >= 0; i = search.prev[i]) {
    waypoints.unshift(search.graph.nodes[i].point);
    crossings.unshift(search.via[i]);
  }
  return { waypoints, crossings, lengthM: search.dist[goal] };
}
