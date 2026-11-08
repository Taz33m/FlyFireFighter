/**
 * The walking corridor of a route: each leg's horizontal line buffered by CORRIDOR_HALF_WIDTH_M as a vertical
 * prism. A leg inside a room spans that room floor to ceiling (a fire anywhere beside the walking line
 * blocks it, whatever height a sensor placed it at); a stair or exterior leg spans its own height range down
 * to the tread or ground, plus headroom. Overlap uses the contracts' conservative region queries.
 */
import type { Vec3 } from "../../contracts/frames.ts";
import type { Point2, Region } from "../../contracts/geometry.ts";
import { distanceToRegion, prism, regionContains, regionsOverlap, representativePoint, samplePoints } from "../../contracts/geometry.ts";
import type { StaticGraph } from "./graph.ts";
import { NODE_HEIGHT_M } from "./graph.ts";
import { direction2 } from "./plane.ts";
import type { Leg } from "./search.ts";

export const CORRIDOR_HALF_WIDTH_M = 0.5;
export const HEADROOM_M = 1.2;
const OVERLAP_SPACING_M = 0.2;
const VERIFY_SPACING_M = 0.25;
const MAX_VERIFY_POINTS = 256;

type LegShape = Pick<Leg, "a" | "b" | "kind" | "space">;

export function legBand(leg: LegShape, graph: StaticGraph): readonly [number, number] {
  const room = graph.rooms.get(leg.space);
  if (room) return [room.zMin, room.zMax];
  const low = Math.min(leg.a.z, leg.b.z);
  const high = Math.max(leg.a.z, leg.b.z) + HEADROOM_M;
  return leg.kind === "stair" ? [low - NODE_HEIGHT_M, high] : [Math.min(low, graph.groundZ), high];
}

/** The leg's corridor: a rectangle around its horizontal line, extended by the half-width at both ends. */
export function legPrism(leg: LegShape, graph: StaticGraph): Region {
  const [zMin, zMax] = legBand(leg, graph);
  const a: Point2 = [leg.a.x, leg.a.y];
  const b: Point2 = [leg.b.x, leg.b.y];
  const [dx, dy] = direction2(a, b) ?? [1, 0];
  const w = CORRIDOR_HALF_WIDTH_M;
  const polygon: Point2[] = [
    [a[0] - (dx - dy) * w, a[1] - (dy + dx) * w],
    [b[0] + (dx + dy) * w, b[1] + (dy - dx) * w],
    [b[0] + (dx - dy) * w, b[1] + (dy + dx) * w],
    [a[0] - (dx + dy) * w, a[1] - (dy - dx) * w],
  ];
  return prism(polygon, zMin, zMax);
}

export function corridorOf(legs: readonly LegShape[], graph: StaticGraph): Region[] {
  return legs.map(leg => legPrism(leg, graph));
}

/** Exact for spheres (how sensors report fire); sampling-based for other regions. */
export function overlapsCorridor(region: Region, corridor: readonly Region[]): boolean {
  if (region.kind === "sphere") return corridor.some(part => distanceToRegion(part, region.center) <= region.radiusM);
  return corridor.some(part => regionsOverlap(region, part, OVERLAP_SPACING_M));
}

export function inCorridor(p: Vec3, corridor: readonly Region[]): boolean {
  return corridor.some(part => regionContains(part, p));
}

/**
 * Points where a hazard region meets the corridor, to be re-observed: the region's own samples inside the
 * corridor, else corridor samples inside the region, else the region's representative point.
 */
export function corridorPointsIn(region: Region, corridor: readonly Region[]): Vec3[] {
  const own = samplePoints(region, VERIFY_SPACING_M, 0, MAX_VERIFY_POINTS).filter(p => inCorridor(p, corridor));
  if (own.length > 0) return own;
  const theirs = corridor
    .filter(part => regionsOverlap(region, part, OVERLAP_SPACING_M))
    .flatMap(part => samplePoints(part, VERIFY_SPACING_M, 0, MAX_VERIFY_POINTS).filter(p => regionContains(region, p)));
  return theirs.length > 0 ? theirs : [representativePoint(region)];
}
