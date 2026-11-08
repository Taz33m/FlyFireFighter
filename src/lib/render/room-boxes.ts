/**
 * Room volumes as axis-aligned boxes for the smoke shader.
 *
 * Scene rooms are vertical prisms over rectilinear floor polygons (some L-shaped). The renderer integrates
 * smoke optical depth along each camera ray through boxes, so every room polygon is decomposed into
 * non-overlapping rectangles: exact for rectilinear polygons, a cell-centre approximation otherwise.
 */
import type { Point2 } from "../contracts/geometry.ts";
import { pointInPolygon } from "../contracts/geometry.ts";

export interface Rect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** A world-frame box (metres, Z up). */
export interface WorldBox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

function sortedUnique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Merge runs of inside cells within one vertical strip into rectangles. */
function stripRects(x0: number, x1: number, ys: readonly number[], polygon: readonly Point2[]): Rect[] {
  const rects: Rect[] = [];
  let start: number | null = null;
  for (let j = 0; j < ys.length - 1; j++) {
    const inside = pointInPolygon((x0 + x1) / 2, (ys[j] + ys[j + 1]) / 2, polygon);
    if (inside && start === null) start = ys[j];
    if (!inside && start !== null) {
      rects.push({ minX: x0, minY: start, maxX: x1, maxY: ys[j] });
      start = null;
    }
  }
  if (start !== null) rects.push({ minX: x0, minY: start, maxX: x1, maxY: ys[ys.length - 1] });
  return rects;
}

/** Decompose a floor polygon into non-overlapping rectangles, merging neighbouring strips with equal spans. */
export function polygonToRects(polygon: readonly Point2[]): Rect[] {
  if (polygon.length < 3) return [];
  const xs = sortedUnique(polygon.map(p => p[0]));
  const ys = sortedUnique(polygon.map(p => p[1]));
  const merged: Rect[] = [];
  let open: Rect[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const strip = stripRects(xs[i], xs[i + 1], ys, polygon);
    const next: Rect[] = [];
    for (const rect of strip) {
      const previous = open.find(r => r.minY === rect.minY && r.maxY === rect.maxY && r.maxX === rect.minX);
      if (previous !== undefined) {
        open = open.filter(r => r !== previous);
        next.push({ ...previous, maxX: rect.maxX });
      } else {
        next.push(rect);
      }
    }
    merged.push(...open);
    open = next;
  }
  return [...merged, ...open];
}

/** World-frame boxes for one room prism. */
export function roomBoxes(polygon: readonly Point2[], zMin: number, zMax: number): WorldBox[] {
  return polygonToRects(polygon).map(r => ({ min: [r.minX, r.minY, zMin], max: [r.maxX, r.maxY, zMax] }));
}
