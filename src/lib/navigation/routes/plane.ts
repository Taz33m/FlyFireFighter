/**
 * Plane geometry for route finding over the floor-plan prior: points are [x, y] in the world frame
 * (metres) and polygons close implicitly. Heights are the caller's business (rooms, stairs, exterior).
 */
import type { Point2 } from "../../contracts/geometry.ts";
import { pointInPolygon, polygonArea } from "../../contracts/geometry.ts";

const EPS = 1e-12;

/** z of (a − o) × (b − o): positive when o → a → b turns counter-clockwise. */
export function cross2(o: Point2, a: Point2, b: Point2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

export function distance2(a: Point2, b: Point2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function midpoint2(a: Point2, b: Point2): Point2 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Unit vector from a toward b, or null when they coincide. */
export function direction2(a: Point2, b: Point2): Point2 | null {
  const length = distance2(a, b);
  return length > EPS ? [(b[0] - a[0]) / length, (b[1] - a[1]) / length] : null;
}

/** Closest point of segment ab to p. */
export function closestOnSegment(p: Point2, a: Point2, b: Point2): Point2 {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return [a[0] + t * dx, a[1] + t * dy];
}

export function pointSegmentDistance(p: Point2, a: Point2, b: Point2): number {
  return distance2(p, closestOnSegment(p, a, b));
}

function opposite(u: number, v: number): boolean {
  return (u > EPS && v < -EPS) || (u < -EPS && v > EPS);
}

/** Segments cross at a single point interior to both. */
function properlyCross(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  return opposite(cross2(c, d, a), cross2(c, d, b)) && opposite(cross2(a, b, c), cross2(a, b, d));
}

/** Distance between segments ab and cd; 0 when they cross or touch. */
export function segmentDistance(a: Point2, b: Point2, c: Point2, d: Point2): number {
  if (properlyCross(a, b, c, d)) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

/** Smallest distance from segment ab to the polygon's boundary. */
export function boundaryDistance(a: Point2, b: Point2, polygon: readonly Point2[]): number {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) best = Math.min(best, segmentDistance(a, b, polygon[j], polygon[i]));
  return best;
}

export function pointBoundaryDistance(p: Point2, polygon: readonly Point2[]): number {
  return boundaryDistance(p, p, polygon);
}

export function insidePolygon(p: Point2, polygon: readonly Point2[]): boolean {
  return pointInPolygon(p[0], p[1], polygon);
}

/** Segment ab lies inside the polygon and never comes closer than `clearance` to its boundary. */
export function clearInside(a: Point2, b: Point2, polygon: readonly Point2[], clearance: number): boolean {
  return insidePolygon(midpoint2(a, b), polygon) && boundaryDistance(a, b, polygon) >= clearance;
}

/** Segment ab stays outside every polygon and at least `clearance` from each. */
export function clearOutside(a: Point2, b: Point2, polygons: readonly (readonly Point2[])[], clearance: number): boolean {
  const mid = midpoint2(a, b);
  return polygons.every(polygon => !insidePolygon(mid, polygon) && boundaryDistance(a, b, polygon) >= clearance);
}

/** Nearest point of the polygon's boundary to p. */
export function nearestBoundaryPoint(p: Point2, polygon: readonly Point2[]): Point2 {
  let best: Point2 = polygon[0];
  let bestDistance = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const candidate = closestOnSegment(p, polygon[j], polygon[i]);
    const d = distance2(p, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

export interface PolygonCorner {
  readonly index: number;
  readonly vertex: Point2;
  /** Unit directions of the incoming edge (into the vertex) and the outgoing edge, counter-clockwise order. */
  readonly incoming: Point2;
  readonly outgoing: Point2;
  /** True when the interior angle exceeds 180 degrees. */
  readonly reflex: boolean;
}

/** Corners of a polygon traversed counter-clockwise (clockwise input is reversed); degenerate ones are skipped. */
export function polygonCorners(polygon: readonly Point2[]): PolygonCorner[] {
  const ring = polygonArea(polygon) < 0 ? [...polygon].reverse() : [...polygon];
  const corners: PolygonCorner[] = [];
  ring.forEach((vertex, index) => {
    const incoming = direction2(ring[(index + ring.length - 1) % ring.length], vertex);
    const outgoing = direction2(vertex, ring[(index + 1) % ring.length]);
    if (!incoming || !outgoing) return;
    const turn = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
    if (Math.abs(turn) > 1e-9) corners.push({ index, vertex, incoming, outgoing, reflex: turn < 0 });
  });
  return corners;
}

/**
 * The point offset `distance` along incoming − outgoing from a corner: into the room at a reflex corner,
 * away from it at a convex corner. For a right angle it lies `distance` from both walls.
 */
export function cornerOffset(corner: PolygonCorner, distance: number): Point2 {
  return [corner.vertex[0] + distance * (corner.incoming[0] - corner.outgoing[0]), corner.vertex[1] + distance * (corner.incoming[1] - corner.outgoing[1])];
}
