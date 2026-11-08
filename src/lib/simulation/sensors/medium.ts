/**
 * Room geometry for the smoke and heat field: which room (compartment) contains a point and how a straight
 * segment divides among rooms and the exterior. Pure geometry over the immutable scene, cached per scene
 * object (derived data only, so caching never changes simulation results). Used by fire.ts for extinction,
 * optical depth and temperature queries, and through those by the sensor models.
 */
import type { Vec3 } from "../../contracts/frames.ts";
import type { Point2 } from "../../contracts/geometry.ts";
import { polygonArea } from "../../contracts/geometry.ts";
import type { RuntimeRoom, SceneModel } from "../world-state.ts";

export interface RoomGeometry {
  readonly room: RuntimeRoom;
  readonly index: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /** Interior lining area (walls, floor and ceiling) that loses heat, m². */
  readonly liningM2: number;
  /** Air volume: the scene's value, else polygon area × height, m³ (at least MIN_VOLUME_M3, so a degenerate room cannot divide by zero). */
  readonly volumeM3: number;
  /** The polygon's vertex coordinates as flat arrays, for the hot containment test (same arithmetic as pointInPolygon). */
  readonly xs: Float64Array;
  readonly ys: Float64Array;
}

/** Part of a segment parameterized 0..1 from a to b; room -1 is the exterior. */
export interface SegmentInterval {
  readonly t0: number;
  readonly t1: number;
  readonly room: number;
}

const MIN_VOLUME_M3 = 0.5;
const geometryCache = new WeakMap<SceneModel, readonly RoomGeometry[]>();

export function roomGeometry(scene: SceneModel): readonly RoomGeometry[] {
  const cached = geometryCache.get(scene);
  if (cached) return cached;
  const built = scene.rooms.map((room, index) => buildRoom(room, index));
  geometryCache.set(scene, built);
  return built;
}

function buildRoom(room: RuntimeRoom, index: number): RoomGeometry {
  const xs = room.polygon.map(p => p[0]);
  const ys = room.polygon.map(p => p[1]);
  const height = Math.max(0, room.zMax - room.zMin);
  const area = Math.abs(polygonArea(room.polygon));
  let perimeter = 0;
  for (let i = 0, j = room.polygon.length - 1; i < room.polygon.length; j = i++) {
    perimeter += Math.hypot(room.polygon[i][0] - room.polygon[j][0], room.polygon[i][1] - room.polygon[j][1]);
  }
  return {
    room,
    index,
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
    liningM2: perimeter * height + 2 * area,
    volumeM3: Math.max(MIN_VOLUME_M3, room.volumeM3 > 0 ? room.volumeM3 : area * height),
    xs: Float64Array.from(xs),
    ys: Float64Array.from(ys),
  };
}

/**
 * contracts/geometry.ts pointInPolygon over the flat vertex arrays: the same comparisons and arithmetic in the
 * same order, so the same answer, without per-vertex tuple access (temperature and smoke queries call this in
 * the sensors' inner loops).
 */
function insidePolygon(g: RoomGeometry, x: number, y: number): boolean {
  const { xs, ys } = g;
  let inside = false;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    const xi = xs[i];
    const yi = ys[i];
    const xj = xs[j];
    const yj = ys[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function containsPoint(g: RoomGeometry, p: Vec3): boolean {
  if (p.z < g.room.zMin || p.z > g.room.zMax) return false;
  if (p.x < g.minX || p.x > g.maxX || p.y < g.minY || p.y > g.maxY) return false;
  return insidePolygon(g, p.x, p.y);
}

/** Index of the first room containing p, or -1 for the exterior. */
export function roomIndexAt(scene: SceneModel, p: Vec3): number {
  const rooms = roomGeometry(scene);
  for (let k = 0; k < rooms.length; k++) if (containsPoint(rooms[k], p)) return rooms[k].index;
  return -1;
}

/**
 * Divide the segment a→b among rooms and the exterior. Intervals are sorted, non-overlapping and cover
 * [0, 1]. Boundaries come from exact polygon-edge crossings and height bands, so results do not depend on
 * a step size. Where rooms overlap (they should not), the earlier interval wins.
 */
export function segmentIntervals(scene: SceneModel, a: Vec3, b: Vec3): SegmentInterval[] {
  const pieces: SegmentInterval[] = [];
  for (const g of roomGeometry(scene)) collectRoom(g, a, b, pieces);
  pieces.sort((p, q) => p.t0 - q.t0);
  const out: SegmentInterval[] = [];
  let cursor = 0;
  for (const piece of pieces) {
    const t0 = Math.max(piece.t0, cursor);
    if (piece.t1 <= t0) continue;
    if (t0 > cursor) out.push({ t0: cursor, t1: t0, room: -1 });
    out.push({ t0, t1: piece.t1, room: piece.room });
    cursor = piece.t1;
  }
  if (cursor < 1) out.push({ t0: cursor, t1: 1, room: -1 });
  return out;
}

function collectRoom(g: RoomGeometry, a: Vec3, b: Vec3, out: SegmentInterval[]): void {
  const z = clipAxis(a.z, b.z, g.room.zMin, g.room.zMax);
  const x = clipAxis(a.x, b.x, g.minX, g.maxX);
  const y = clipAxis(a.y, b.y, g.minY, g.maxY);
  const lo = Math.max(z[0], x[0], y[0]);
  const hi = Math.min(z[1], x[1], y[1]);
  if (!(lo < hi)) return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const polygon = g.room.polygon;
  const ts = [lo, hi];
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const t = edgeCrossing(a.x, a.y, dx, dy, polygon[j], polygon[i]);
    if (t !== null && t > lo && t < hi) ts.push(t);
  }
  ts.sort((p, q) => p - q);
  for (let k = 0; k + 1 < ts.length; k++) {
    const t0 = ts[k];
    const t1 = ts[k + 1];
    const tm = (t0 + t1) / 2;
    if (t1 - t0 > 1e-12 && insidePolygon(g, a.x + dx * tm, a.y + dy * tm)) appendMerged(out, t0, t1, g.index);
  }
}

function appendMerged(out: SegmentInterval[], t0: number, t1: number, room: number): void {
  const last = out.length > 0 ? out[out.length - 1] : null;
  if (last !== null && last.room === room && Math.abs(last.t1 - t0) < 1e-12) out[out.length - 1] = { t0: last.t0, t1, room };
  else out.push({ t0, t1, room });
}

/** Parameter range within [0, 1] where a + t·(b − a) lies in [min, max] on one axis; empty when t0 ≥ t1. */
function clipAxis(a: number, b: number, min: number, max: number): readonly [number, number] {
  const d = b - a;
  if (Math.abs(d) < 1e-12) return a >= min && a <= max ? [0, 1] : [1, 0];
  const t0 = (min - a) / d;
  const t1 = (max - a) / d;
  return t0 < t1 ? [Math.max(0, t0), Math.min(1, t1)] : [Math.max(0, t1), Math.min(1, t0)];
}

/** Segment parameter where the 2D segment from (ax, ay) along (dx, dy) crosses the edge p→q, or null. */
function edgeCrossing(ax: number, ay: number, dx: number, dy: number, p: Point2, q: Point2): number | null {
  const ex = q[0] - p[0];
  const ey = q[1] - p[1];
  const denominator = dx * ey - dy * ex;
  if (Math.abs(denominator) < 1e-15) return null;
  const wx = p[0] - ax;
  const wy = p[1] - ay;
  const u = (wx * dy - wy * dx) / denominator;
  return u >= 0 && u <= 1 ? (wx * ey - wy * ex) / denominator : null;
}
